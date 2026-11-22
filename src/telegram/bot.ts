import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bot, Context, InputFile } from 'grammy';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import type { CommandBridge, Notifier } from '../core/bridge';
import type { SessionStore } from '../core/sessionStore';
import type { AgentAdapter } from '../agents/types';
import { describeAgent } from '../config';
import type { KeyedQueue } from '../core/taskQueue';
import { runCommand, stripAnsi } from '../util/process';
import { formatReadiness, inspectReadiness } from '../readiness';
import { markdownToTelegramHtml } from './format';
import type { ReplyRouteStore } from './replyRoutes';
import type { AgentProcess } from '../core/processRegistry';

const TELEGRAM_TEXT_LIMIT = 4000;

export function splitMessage(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = '';
      }
      for (let index = 0; index < line.length; index += limit) {
        chunks.push(line.slice(index, index + limit));
      }
      continue;
    }
    if ((current + line).length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface BotDeps {
  config: AppConfig;
  bridge: CommandBridge;
  store: SessionStore;
  queue: KeyedQueue;
  logger: Logger;
  /** Agente seleccionado (AGENT): etiqueta, estado y comprobaciones previas. */
  agent: AgentAdapter;
  /** Proyecto asociado a cada mensaje enviado, para enrutar respuestas. */
  replyRoutes: ReplyRouteStore;
}

const helpText = (agentLabel: string): string =>
  [
  `Mandame una *nota de voz* o escribe tu orden y la ejecuto con ${agentLabel} en la PC.`,
  '',
  'Comandos:',
  '/new - empezar un hilo de conversacion nuevo',
  '/status - estado del puente y de la sesion',
  '/voices - voces TTS instaladas en Windows',
  '/help - esta ayuda'
].join('\n');

async function sendLongText(ctx: Context, text: string): Promise<{ messageId?: number }> {
  let lastMessageId: number | undefined;
  for (const chunk of splitMessage(text)) {
    // Los resumenes de Devin vienen en Markdown; se convierten a HTML porque
    // Telegram no lo interpreta. Si el HTML quedara mal formado, se reintenta
    // en texto plano para no perder el mensaje.
    try {
      const sent = await ctx.reply(markdownToTelegramHtml(chunk), {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true }
      });
      lastMessageId = sent.message_id;
    } catch {
      const sent = await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
      lastMessageId = sent.message_id;
    }
  }
  return { messageId: lastMessageId };
}

function createNotifier(ctx: Context): Notifier {
  return {
    text: (message) => sendLongText(ctx, message),
    voice: async (filePath) => {
      await ctx.replyWithVoice(new InputFile(filePath));
    }
  };
}

async function downloadVoiceFile(
  ctx: Context,
  fileId: string,
  tmpDir: string,
  token: string
): Promise<string> {
  const file = await ctx.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram no devolvio la ruta del archivo');

  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`No pude descargar el audio (HTTP ${response.status})`);

  const extension = path.extname(file.file_path) || '.oga';
  const destination = path.join(tmpDir, `voice-${randomUUID()}${extension}`);
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return destination;
}

const MAX_PROCESS_BUTTONS = 8;

/**
 * "¿Por qué tarda tanto?" no es una orden: es una pregunta sobre lo que hay en marcha.
 * Se exige que el mensaje sea corto para no secuestrar ordenes que mencionen la lentitud.
 */
export function isDelayQuestion(text: string): boolean {
  // Sin acentos ni signos: "¿por qué tarda tanto?" y "por que tarda tanto" son lo mismo.
  const clean = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
  if (!clean || clean.length > 60) return false;
  return (
    /(por que|porque|pq)\s+(tarda|esta tardando|va lento|va tan lento|tarda tanto)/.test(clean) ||
    /(esta|está)\s+tardando/.test(clean) ||
    /tarda\s+(tanto|mucho)/.test(clean) ||
    /que\s+esta\s+haciendo/.test(clean)
  );
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Texto del listado de procesos en marcha. */
export function formatProcessList(processes: AgentProcess[], now = Date.now()): string {
  if (processes.length === 0) {
    return '🔎 No hay ningun proceso del agente en marcha ahora mismo.';
  }

  const lines = [`🔎 Procesos del agente en marcha (${processes.length}):`, ''];
  for (const process of processes.slice(0, 10)) {
    const elapsed = formatElapsed(now - process.startedAt);
    const origin = process.source === 'bridge' ? process.label : `${process.label} (fuera del puente)`;
    lines.push(`• PID ${process.pid} · ${origin} · ${elapsed}`);
    const detail = process.prompt.trim() || process.commandLine?.trim() || '';
    if (detail) lines.push(`  "${detail.length > 90 ? `${detail.slice(0, 87)}...` : detail}"`);
  }
  if (processes.length > 10) lines.push(`… y ${processes.length - 10} mas`);
  lines.push('', 'Pulsa uno para detenerlo. Detener una orden corta el trabajo en curso.');
  return lines.join('\n');
}

function processKeyboard(processes: AgentProcess[], now = Date.now()) {
  const rows = processes.slice(0, MAX_PROCESS_BUTTONS).map((process) => [
    {
      text: `⛔ ${process.pid} · ${process.label} · ${formatElapsed(now - process.startedAt)}`,
      callback_data: `proc:stop:${process.pid}`
    }
  ]);
  rows.push([{ text: '🔄 Actualizar', callback_data: 'proc:list' }]);
  return { inline_keyboard: rows };
}

export function createTelegramBot(deps: BotDeps): Bot {
  const { config, bridge, store, queue, logger, replyRoutes, agent } = deps;
  const bot = new Bot(config.telegram.token);
  const allowed = new Set(config.telegram.allowedUserIds);

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Sin allowlist no se ejecuta nada: solo se ayuda a descubrir el user id.
    if (allowed.size === 0) {
      logger.warn('Bootstrap: mensaje recibido', { userId, username: ctx.from?.username });
      await ctx.reply(
        `⚠️ Falta configurar TELEGRAM_ALLOWED_USER_IDS.\nTu user id es ${userId}. Anadelo al .env y reinicia el puente.`
      );
      return;
    }

    if (!allowed.has(userId)) {
      logger.warn('Mensaje de usuario no autorizado', { userId, username: ctx.from?.username });
      if (ctx.chat?.type === 'private') {
        await ctx.reply(`No autorizado. Tu user id es ${userId}; anadelo a TELEGRAM_ALLOWED_USER_IDS.`);
      }
      return;
    }

    await next();
  });

  bot.command('start', (ctx) => sendLongText(ctx, `Hola. ${helpText(agent.label)}`));
  bot.command('help', (ctx) => sendLongText(ctx, helpText(agent.label)));

  bot.command('new', async (ctx) => {
    const chatId = String(ctx.chat.id);
    await store.reset(chatId);
    await ctx.reply(`🆕 Hilo nuevo. La proxima orden arranca una sesion limpia de ${agent.label}.`);
  });

  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const session = store.get(chatId);
    const readiness = await inspectReadiness(config, agent);

    const lines = [
      `Agente: ${agent.label} (${describeAgent(config)})`,
      `Carpeta de trabajo: ${config.agent.workdir}`,
      `Transcripcion: ${config.whisper.language} / ${path.basename(config.whisper.model)}`,
      `TTS: ${config.tts.enabled ? 'activado' : 'desactivado'}`,
      `Ordenes en cola: ${queue.pendingFor(chatId)}`,
      `Sesion: ${session?.sessionId ?? (session?.runs ? 'por continuacion' : 'sin iniciar')}`,
      `Ordenes ejecutadas: ${session?.runs ?? 0}`,
      '',
      readiness.ok ? '✅ Todo listo' : '⚠️ Hay pendientes',
      formatReadiness(readiness)
    ];
    await sendLongText(ctx, lines.join('\n'));
  });

  bot.command('voices', async (ctx) => {
    const result = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', config.paths.ttsScript, '-ListVoices'],
      { timeoutMs: 30_000 }
    );
    const voices = stripAnsi(result.stdout).trim();
    await sendLongText(
      ctx,
      voices
        ? `Voces disponibles (nombre | cultura | genero):\n${voices}\n\nFija una con TTS_VOICE en el .env`
        : `No pude listar las voces: ${result.stderr.trim() || 'sin salida'}`
    );
  });

  const renderProcesses = async (ctx: Context, mode: 'reply' | 'edit'): Promise<void> => {
    try {
      const processes = await bridge.listProcesses();
      const text = formatProcessList(processes);
      const replyMarkup = processKeyboard(processes);

      if (mode === 'edit' && ctx.callbackQuery?.message) {
        await ctx.editMessageText(text, { reply_markup: replyMarkup });
        return;
      }
      await sendLongText(ctx, text);
      await ctx.reply('Opciones:', { reply_markup: replyMarkup });
    } catch (error) {
      logger.warn('No pude listar los procesos', error);
      await ctx.reply('No pude leer los procesos en marcha.');
    }
  };

  bot.command('procesos', async (ctx) => {
    await renderProcesses(ctx, 'reply');
  });

  bot.callbackQuery('proc:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    await renderProcesses(ctx, 'edit');
  });

  bot.callbackQuery(/^proc:stop:(\d+)$/, async (ctx) => {
    const pid = Number(ctx.match?.[1]);
    const result = await bridge.stopProcess(pid);
    await ctx.answerCallbackQuery(
      result.stopped ? `Detenido el proceso ${pid}` : result.reason ?? 'No pude detenerlo'
    );
    await renderProcesses(ctx, 'edit');
  });

  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const chatId = String(ctx.chat.id);
    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) return;

    const notifier = createNotifier(ctx);
    try {
      const audioPath = await downloadVoiceFile(ctx, fileId, config.paths.tmp, config.telegram.token);
      const repliedProject = replyRoutes.resolve(ctx.message.reply_to_message?.message_id)?.project;
      void bridge
        .handleVoice(chatId, audioPath, notifier, repliedProject ? { project: repliedProject } : {})
        .catch((error) => logger.error('Fallo el flujo de voz', error))
        .finally(() => fs.rm(audioPath, { force: true }).catch(() => undefined));
    } catch (error) {
      logger.error('No pude descargar el audio', error);
      await notifier.text(`❌ No pude descargar el audio: ${(error as Error).message}`);
    }
  });

  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;

    // "¿Por qué tarda tanto?" se responde con lo que hay en marcha, no como orden nueva.
    if (isDelayQuestion(text)) {
      await renderProcesses(ctx, 'reply');
      return;
    }

    const notifier = createNotifier(ctx);
    void bridge
      .handlePrompt(chatId, text, notifier, replyRoutes.resolve(ctx.message.reply_to_message?.message_id)?.project ? { project: replyRoutes.resolve(ctx.message.reply_to_message?.message_id)?.project } : {})
      .catch((error) => logger.error('Fallo el flujo de texto', error));
  });

  bot.catch((error) => {
    logger.error('Error no controlado del bot', error.error);
  });

  return bot;
}
