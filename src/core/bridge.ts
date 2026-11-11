import path from 'node:path';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { AppConfig } from '../config';
import type { Logger } from '../logger';
import type { Transcriber } from '../audio/whisper';
import type { TextToSpeech } from '../audio/tts';
import type { DevinRunner } from '../devin/devinRunner';
import type { SessionStore } from '../devin/sessionStore';
import type { KeyedQueue } from './taskQueue';
import type { BridgeState, StatusPublisher } from './statusPublisher';
import { TaskRegistry, type TaskRecord } from './taskRegistry';
import type { SessionSnapshot } from './sessionMonitor';
import { formatDuration } from '../util/format';

export { formatDuration };

export interface Notifier {
  text(message: string): Promise<void>;
  voice(filePath: string): Promise<void>;
}

export interface BridgeDeps {
  runner: Pick<DevinRunner, 'run'>;
  transcriber: Pick<Transcriber, 'transcribe' | 'name'>;
  tts: Pick<TextToSpeech, 'synthesize'> | null;
  store: SessionStore;
  queue: KeyedQueue;
  config: AppConfig;
  logger: Logger;
  status?: Pick<StatusPublisher, 'publish'>;
  /** Sesiones de Devin (IDE y CLI) para publicarlas en el panel. */
  sessions?: () => SessionSnapshot[];
}

/** Formatea duraciones cortas para el resumen. */
export function buildSummary(text: string, durationMs: number, pending = 0): string {
  const body = text.trim() || 'Termine la tarea, pero no produje texto de resumen.';
  const tail =
    pending > 0 ? `\n\n⏳ Quedan ${pending} orden(es) en cola.` : '\n\n🟢 Esperando nuevas ordenes.';
  return `✅ Listo en ${formatDuration(durationMs)}\n\n${body}${tail}`;
}

/**
 * Orquesta el flujo: audio -> texto -> Devin -> resumen -> (audio de vuelta).
 * No conoce Telegram: recibe un Notifier, lo que lo hace testeable.
 */
export class CommandBridge {
  private readonly registry = new TaskRegistry();

  constructor(private readonly deps: BridgeDeps) {}

  async handleVoice(chatId: string, audioFile: string, notifier: Notifier): Promise<void> {
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
    await this.runOrder(chatId, transcript, notifier, transcribeMs);
  }

  async handlePrompt(chatId: string, prompt: string, notifier: Notifier): Promise<void> {
    await this.runOrder(chatId, prompt, notifier);
  }

  /** Republica el estado (lo usa el vigilante de agentes externos al detectar cambios). */
  async refreshStatus(): Promise<void> {
    await this.publishStatus();
  }

  private async runOrder(
    chatId: string,
    prompt: string,
    notifier: Notifier,
    transcribeMs?: number
  ): Promise<void> {
    const { queue, config, logger } = this.deps;
    const queued = queue.pendingFor(chatId);
    if (queued > 0) {
      await notifier.text(`⏳ Hay ${queued} orden(es) en curso. La tuya va despues.`);
    }

    const task = this.registry.create({ chatId, prompt });

    await queue.enqueue(chatId, async () => {
      const startedAt = Date.now();
      this.registry.update(task.id, { state: 'working', startedAt });
      await this.publishStatus('working');

      try {
        if (transcribeMs === undefined) await notifier.text('🤖 Trabajando...');

        const session = this.deps.store.get(chatId);
        const continuity = config.devin.continuity;
        const sessionId = continuity === 'new' ? undefined : session?.sessionId;
        const allowContinue =
          !sessionId && (continuity === 'continue' || (continuity === 'auto' && (session?.runs ?? 0) > 0));

        const result = await this.deps.runner.run({
          prompt,
          sessionId,
          allowContinue,
          cwd: config.devin.workdir,
          timeoutMs: config.devin.timeoutMs
        });

        await this.deps.store.record(chatId, {
          cwd: config.devin.workdir,
          sessionId: result.sessionId,
          lastPrompt: prompt
        });

        const pending = Math.max(0, queue.pendingFor(chatId) - 1);
        const summary = buildSummary(result.text, result.durationMs, pending);
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
