import { createHash } from 'node:crypto';
import type { Logger } from '../logger';
import type { ReadSessionsOptions, SessionSnapshot } from '../agents/types';

export type { ReadSessionsOptions, SessionSnapshot };

export interface SessionMonitorOptions {
  read?: () => SessionSnapshot[];
  onFinished: (session: SessionSnapshot) => void;
  onChanged?: () => void;
  logger: Logger;
  /** Sesiones que gestiona el propio puente: ya tienen su resumen, no se duplican. */
  ignoreIds?: () => Set<string>;
  pollMs?: number;
  /** Tiempo sin actividad para considerar que un turno ha terminado. */
  settleMs?: number;
  now?: () => number;
}

interface TrackedSession {
  hash: string;
  notifiedHash: string;
  busy: boolean;
}

/**
 * Vigila las sesiones del agente (las de su IDE y las de su CLI) para saber que se esta
 * trabajando y avisar cuando un turno termina. La lectura la aporta el adaptador del
 * agente (`read`), asi que el monitor no conoce a nadie en concreto.
 * La primera lectura solo toma linea base: no notifica lo que ya estaba terminado.
 */
export class SessionMonitor {
  private readonly tracked = new Map<string, TrackedSession>();
  private latest: SessionSnapshot[] = [];
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly options: SessionMonitorOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? 5000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Sesiones para el panel de la bandeja. */
  sessions(): SessionSnapshot[] {
    return this.latest;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const now = this.options.now?.() ?? Date.now();
      const settleMs = this.options.settleMs ?? 20_000;
      const ignore = this.options.ignoreIds?.() ?? new Set<string>();
      const read = this.options.read ?? (() => []);

      const sessions = read().filter((session) => !ignore.has(session.id));
      this.latest = sessions;

      let changed = false;

      for (const session of sessions) {
        const hash = hashSession(session);
        const tracked = this.tracked.get(session.id);

        if (!tracked) {
          // Primera vez: linea base, sin avisar de lo ya terminado.
          this.tracked.set(session.id, { hash, notifiedHash: hash, busy: session.state === 'working' });
          changed = true;
          continue;
        }

        if (tracked.hash !== hash) {
          tracked.hash = hash;
          tracked.busy = true;
          changed = true;
        }

        const settled = now - session.lastActivityAt >= settleMs;
        const hasText = session.lastText.trim().length > 0;
        const isFinal = session.lastRole === 'assistant';

        if (settled && tracked.busy && isFinal && hasText && tracked.notifiedHash !== hash) {
          tracked.notifiedHash = hash;
          tracked.busy = false;
          try {
            this.options.onFinished(session);
          } catch (error) {
            this.options.logger.warn('Fallo el aviso de sesion terminada', error);
          }
        }
      }

      if (changed) this.options.onChanged?.();
    } finally {
      this.polling = false;
    }
  }
}

function hashSession(session: SessionSnapshot): string {
  return createHash('sha1')
    .update(`${session.lastRowId}:${session.lastRole}:${session.lastText.length}:${session.lastText.slice(-200)}`)
    .digest('hex');
}

/**
 * Busca la sesion de un proyecto concreto, para enrutar la orden al historial del IDE.
 * Se comparan rutas normalizadas (Windows no distingue mayusculas) y se descartan las
 * sesiones que gestiona el propio puente.
 */
export function findProjectSession(
  sessions: SessionSnapshot[],
  cwd: string,
  ignoreIds?: Set<string>
): SessionSnapshot | null {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const target = normalize(cwd);
  if (!target) return null;

  return (
    sessions.find(
      (session) => normalize(session.cwd) === target && !(ignoreIds?.has(session.id) ?? false)
    ) ?? null
  );
}

/** Mensaje que recibe el usuario cuando una sesion del agente termina su turno. */
export function formatFinishedSession(
  session: SessionSnapshot,
  now = Date.now(),
  agentLabel = 'Devin'
): string {
  const project = session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd : 'sin carpeta';
  const idleFor = Math.max(0, Math.round((now - session.lastActivityAt) / 1000));
  const title = session.title.trim() || session.id;
  const summary = session.lastText.trim() || '(sin texto)';
  const label = summary.includes('\n…\n')
    ? 'Resumen de lo que hizo (inicio y final del mensaje):'
    : 'Resumen de lo que hizo:';

  return [
    `✅ Sesion de ${agentLabel} terminada`,
    `Proyecto: ${project}`,
    `Sesion: ${title.length > 80 ? `${title.slice(0, 77)}...` : title}`,
    `Sin actividad desde hace ${idleFor}s`,
    '',
    label,
    summary
  ].join('\n');
}
