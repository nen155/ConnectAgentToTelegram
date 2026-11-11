import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import type { Transcriber } from '../audio/whisper';
import type { TextToSpeech } from '../audio/tts';
import type { SessionStore } from './sessionStore';
import type { AgentCli, AgentDesktop } from '../agents/types';
import { matchProject } from '../agents/projectMatch';
import type { KeyedQueue } from './taskQueue';
import type { BridgeState, StatusPublisher } from './statusPublisher';
import { TaskRegistry, type TaskRecord } from './taskRegistry';
import type { SessionSnapshot } from './sessionMonitor';
import { summarizeMessage } from './sessionDigest';
import { formatDuration } from '../util/format';

export { formatDuration };

export interface Notifier {
  /** Devuelve el id del mensaje enviado, para poder enrutar respuestas a el. */
  text(message: string): Promise<{ messageId?: number } | void>;
  voice(filePath: string): Promise<void>;
}

export interface OrderOptions {
  /** Proyecto forzado (p. ej. porque la orden responde a un mensaje de ese proyecto). */
  project?: string;
}

/** Sesion del IDE que corresponde al proyecto donde trabaja el puente. */
export interface IdeSessionRoute {
  id: string;
  title: string;
  /** true si esa sesion esta trabajando ahora mismo: no se le mete otra orden. */
  busy: boolean;
}

export interface BridgeDeps {
  runner: AgentCli;
  transcriber: Pick<Transcriber, 'transcribe' | 'name'>;
  tts: Pick<TextToSpeech, 'synthesize'> | null;
  store: SessionStore;
  queue: KeyedQueue;
  config: AppConfig;
  logger: Logger;
  status?: Pick<StatusPublisher, 'publish'>;
  /** Sesiones de Devin (IDE y CLI) para publicarlas en el panel. */
  sessions?: () => SessionSnapshot[];
  /** Resuelve la sesion del IDE para el proyecto configurado, si existe. */
  resolveIdeSession?: () => Promise<IdeSessionRoute | null>;
  /** Escribe la orden en la ventana del IDE (DEVIN_ROUTE=desktop). */
  desktop?: AgentDesktop;
  /** Proyectos conocidos (carpetas de sesiones recientes), para detectar menciones sin ventana. */
  knownProjects?: () => Promise<string[]>;
  /** Guarda el proyecto asociado a un mensaje enviado, para enrutar respuestas. */
  rememberRoute?: (messageId: number, project: string) => void;
}

/** Formatea duraciones cortas para el resumen. */
/** Añade al final de la orden la instruccion de idioma para el resumen del agente. */
export function withLanguageInstruction(prompt: string, language: '' | 'es' | 'en'): string {
  if (!language) return prompt;
  const name = language === 'es' ? 'español' : 'inglés';
  return `${prompt}\n\nResponde el resumen final en ${name}.`;
}

export function buildSummary(text: string, durationMs: number, pending = 0, note?: string): string {
  // Se envia un resumen, no la salida completa: principio para el contexto y final
  // porque ahi esta la conclusion de lo que hizo el modelo.
  const body = summarizeMessage(text) || 'Termine la tarea, pero no produje texto de resumen.';
  const tail =
    pending > 0 ? `\n\n⏳ Quedan ${pending} orden(es) en cola.` : '\n\n🟢 Esperando nuevas ordenes.';
  const header = `✅ Listo en ${formatDuration(durationMs)}${note ? `\n${note}` : ''}`;
  return `${header}\n\n${body}${tail}`;
}

/**
 * Orquesta el flujo: audio -> texto -> Devin -> resumen -> (audio de vuelta).
 * No conoce Telegram: recibe un Notifier, lo que lo hace testeable.
 */
export class CommandBridge {
  private readonly registry = new TaskRegistry();

  constructor(private readonly deps: BridgeDeps) {}

  async handleVoice(chatId: string, audioFile: string, notifier: Notifier, options: OrderOptions = {}): Promise<void> {
    const { transcriber, logger } = this.deps;
    const receivedAt = Date.now();

    // Acuse inmediato: la transcripcion tarda varios segundos y el usuario
    // necesita saber que el audio ha llegado.
    await notifier.text('🎧 Audio recibido, transcribiendo...');
    await this.publishStatus('transcribing');

    let transcript = '';
    try {
      transcript = (await transcriber.transcribe(audioFile)).trim();
    } catch (error) {
      logger.error('Fallo la transcripcion', error);
      await notifier.text(`❌ No pude transcribir el audio: ${(error as Error).message}`);
      await this.publishStatus();
      return;
    }

    if (!transcript) {
      await notifier.text('🎧 No entendi nada en el audio. Prueba a hablar un poco mas cerca del microfono.');
      await this.publishStatus();
      return;
    }

    const transcribeMs = Date.now() - receivedAt;
    await notifier.text(`🎧 Entendi en ${formatDuration(transcribeMs)}: "${transcript}"\n🤖 Trabajando...`);
    await this.runOrder(chatId, transcript, notifier, transcribeMs, options);
  }

  async handlePrompt(
    chatId: string,
    prompt: string,
    notifier: Notifier,
    options: OrderOptions = {}
  ): Promise<void> {
    await this.runOrder(chatId, prompt, notifier, undefined, options);
  }

  /** Republica el estado (lo usa el vigilante de agentes externos al detectar cambios). */
  async refreshStatus(): Promise<void> {
    await this.publishStatus();
  }

  private async runOrder(
    chatId: string,
    prompt: string,
    notifier: Notifier,
    transcribeMs?: number,
    options: OrderOptions = {}
  ): Promise<void> {
    const { queue, config, logger } = this.deps;
    let note: string | undefined;
    const agentPrompt = withLanguageInstruction(prompt, config.summaryLanguage);

    // Enrutado a la UI del agente: su ventana (Devin Desktop) o la terminal del IDE.
    if (config.agent.route === 'desktop' && this.deps.desktop) {
      const windows = await this.deps.desktop.listWindows().catch(() => []);
      const mentioned = matchProject(prompt, windows);

      // Si nombra un proyecto que existe pero cuya ventana no esta abierta, no se cae en
      // la ventana por defecto: se avisa en vez de trabajar en el proyecto equivocado.
      const known = mentioned ? [] : await this.deps.knownProjects?.().catch(() => []) ?? [];
      const mentionedClosed = matchProject(
        prompt,
        known.map((project) => ({ project, title: project }))
      );

      const target =
        options.project ??
        mentioned?.window.project ??
        (mentionedClosed
          ? undefined
          : windows.some((window) => window.project === config.agent.projectName)
            ? config.agent.projectName
            : undefined);

      if (target) {
        const attempt = await this.deps.desktop.send(agentPrompt, target);
        if (attempt.sent) {
          const task = this.registry.create({ chatId, prompt });
          const now = Date.now();
          this.registry.update(task.id, { state: 'done', startedAt: now, finishedAt: now, durationMs: 0 });
          await this.publishStatus();

          const how = options.project
            ? 'porque respondes a un mensaje de ese proyecto'
            : mentioned
              ? 'por el proyecto que has nombrado'
              : 'por la carpeta de trabajo';
          const sent = await notifier.text(
            `📨 Orden enviada a ${config.agent.label} en "${target}" (${how}).\n` +
              'Te aviso con el resumen cuando termine: lo detecta el monitor de sesiones.'
          );
          if (sent?.messageId) this.deps.rememberRoute?.(sent.messageId, target);
          logger.info('Orden enviada al IDE', { chatId, project: target, mentioned: Boolean(mentioned) });
          return;
        }

        note = attempt.reason?.startsWith('SESION_OCUPADA')
          ? `⚠️ ${config.agent.label} esta trabajando en "${target}" y no la pongo en cola; ejecuto la orden en el CLI.`
          : `⚠️ No pude escribir en ${config.agent.label} ("${target}"): ${attempt.reason ?? 'sin acceso'}; la ejecuto en el CLI.`;
        logger.warn('No se pudo enviar al IDE', { project: target, reason: attempt.reason });
      } else if (mentionedClosed) {
        note = `⚠️ La ventana de "${mentionedClosed.window.project}" no esta abierta; la ejecuto en el CLI.`;
      } else {
        note = `⚠️ No hay ninguna ventana abierta para "${config.agent.projectName}"; la ejecuto en el CLI.`;
      }
    }

    // Solo el camino CLI hace cola; los envios a la UI del agente son inmediatos.
    const running = this.registry.active();
    const current = running[0];
    if (current) {
      const label = current.prompt.length > 70 ? `${current.prompt.slice(0, 67)}...` : current.prompt;
      await notifier.text(`⏳ Sigue en curso: "${label}". Tu orden va despues.`);
    }

    const task = this.registry.create({ chatId, prompt });

    await queue.enqueue(chatId, async () => {
      const startedAt = Date.now();
      this.registry.update(task.id, { state: 'working', startedAt });
      await this.publishStatus('working');

      try {
        if (transcribeMs === undefined) await notifier.text('🤖 Trabajando...');

        const session = this.deps.store.get(chatId);
        const continuity = config.agent.continuity;
        let sessionId = continuity === 'new' ? undefined : session?.sessionId;

        // Enrutado: si el proyecto esta abierto en el IDE, la orden continua esa conversacion.
        if (config.agent.route === 'auto' && this.deps.resolveIdeSession) {
          const ide = await this.deps.resolveIdeSession().catch(() => null);
          if (ide && !ide.busy) {
            sessionId = ide.id;
            note = `🔗 Continuando la sesion del IDE: ${ide.title || ide.id}`;
          } else if (ide?.busy) {
            note = '⚠️ La sesion del IDE para este proyecto esta trabajando; abro una sesion nueva.';
          }
        }

        const allowContinue =
          !sessionId && (continuity === 'continue' || (continuity === 'auto' && (session?.runs ?? 0) > 0));

        const result = await this.deps.runner.run({
          prompt: agentPrompt,
          sessionId,
          allowContinue,
          cwd: config.agent.workdir,
          timeoutMs: config.agent.timeoutMs
        });

        await this.deps.store.record(chatId, {
          cwd: config.agent.workdir,
          sessionId: result.sessionId,
          lastPrompt: prompt
        });

        const pending = Math.max(0, queue.pendingFor(chatId) - 1);
        const summary = buildSummary(result.text, result.durationMs, pending, note);
        await notifier.text(summary);

        this.registry.update(task.id, { state: 'replying', sessionId: result.sessionId });
        await this.publishStatus('replying');

        const ttsMs = await this.sendVoiceReply(summary, notifier);

        this.registry.update(task.id, {
          state: 'done',
          finishedAt: Date.now(),
          durationMs: result.durationMs,
          sessionId: result.sessionId,
          exitCode: result.exitCode
        });

        logger.info(`Orden completada en ${formatDuration(Date.now() - startedAt)}`, {
          chatId,
          exitCode: result.exitCode,
          sessionId: result.sessionId,
          transcribeMs: transcribeMs ?? 0,
          devinMs: result.durationMs,
          ttsMs
        });
      } catch (error) {
        const message = (error as Error).message ?? 'Error desconocido';
        logger.error('Fallo la ejecucion de Devin', error);
        this.registry.update(task.id, { state: 'error', finishedAt: Date.now(), error: message });
        await notifier.text(`❌ ${message}`);
      } finally {
        await this.publishStatus();
      }
    });
  }

  /** Estado global derivado de las tareas activas, para el icono de la bandeja. */
  private computeState(): BridgeState {
    const active = this.registry.active();
    if (active.some((task) => task.state === 'working')) return 'working';
    if (active.some((task) => task.state === 'replying')) return 'replying';
    if (active.length > 0) return 'working';
    return 'idle';
  }

  private async publishStatus(state?: BridgeState): Promise<void> {
    const { active, recent } = this.registry.snapshot();
    const current =
      active.find((task) => task.state === 'working') ?? active.find((task) => task.state === 'replying');

    await this.deps.status?.publish(state ?? this.computeState(), {
      active,
      recent,
      current,
      queue: active.filter((task) => task.state === 'queued').length,
      sessions: this.deps.sessions?.() ?? []
    });
  }

  private async sendVoiceReply(text: string, notifier: Notifier): Promise<number> {
    const { tts, config, logger } = this.deps;
    if (!tts) return 0;

    const startedAt = Date.now();
    const oggFile = path.join(config.paths.tmp, `reply-${randomUUID()}.ogg`);
    try {
      await tts.synthesize(text, oggFile);
      await notifier.voice(oggFile);
      return Date.now() - startedAt;
    } catch (error) {
      // Un fallo de TTS no debe invalidar la respuesta: el texto ya se envio.
      logger.warn('No se pudo generar la nota de voz', error);
      return Date.now() - startedAt;
    } finally {
      await fs.rm(oggFile, { force: true }).catch(() => undefined);
    }
  }
}
