import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bot, Context, InputFile } from 'grammy';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import type { CommandBridge, Notifier } from '../core/bridge';
import type { SessionStore } from '../devin/sessionStore';
import type { KeyedQueue } from '../core/taskQueue';
import { runCommand, stripAnsi } from '../util/process';
import { formatReadiness, inspectReadiness } from '../readiness';

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
}

const HELP_TEXT = [
  'Mandame una *nota de voz* o escribe tu orden y la ejecuto con Devin en la PC.',
  '',
  'Comandos:',
  '/new - empezar un hilo de conversacion nuevo',
  '/status - estado del puente y de la sesion',
  '/voices - voces TTS instaladas en Windows',
  '/help - esta ayuda'
].join('\n');

async function sendLongText(ctx: Context, text: string): Promise<void> {
  for (const chunk of splitMessage(text)) {
    await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
  }
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

export function createTelegramBot(deps: BotDeps): Bot {
  const { config, bridge, store, queue, logger } = deps;
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

  bot.command('start', (ctx) => sendLongText(ctx, `Hola. ${HELP_TEXT}`));
  bot.command('help', (ctx) => sendLongText(ctx, HELP_TEXT));

  bot.command('new', async (ctx) => {
    const chatId = String(ctx.chat.id);
    await store.reset(chatId);
    await ctx.reply('🆕 Hilo nuevo. La proxima orden arranca una sesion limpia de Devin.');
  });

  bot.command('status', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const session = store.get(chatId);
    const readiness = await inspectReadiness(config);

    const lines = [
      `Carpeta de trabajo: ${config.devin.workdir}`,
      `Permisos: ${config.devin.permissionMode}`,
      `Transcripcion: ${config.whisper.language} / ${path.basename(config.whisper.model)}`,
      `TTS: ${config.tts.enabled ? 'activado' : 'desactivado'}`,
      `Ordenes en cola: ${queue.pendingFor(chatId)}`,
      `Sesion Devin: ${session?.sessionId ?? (session?.runs ? 'por --continue' : 'sin iniciar')}`,
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

  bot.on(['message:voice', 'message:audio'], async (ctx) => {
    const chatId = String(ctx.chat.id);
    const fileId = ctx.message.voice?.file_id ?? ctx.message.audio?.file_id;
    if (!fileId) return;

    const notifier = createNotifier(ctx);
    try {
      const audioPath = await downloadVoiceFile(ctx, fileId, config.paths.tmp, config.telegram.token);
      void bridge
        .handleVoice(chatId, audioPath, notifier)
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

    const notifier = createNotifier(ctx);
    void bridge
      .handlePrompt(chatId, text, notifier)
      .catch((error) => logger.error('Fallo el flujo de texto', error));
  });

  bot.catch((error) => {
    logger.error('Error no controlado del bot', error.error);
  });

  return bot;
}
