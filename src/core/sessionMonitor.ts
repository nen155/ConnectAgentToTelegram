import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Logger } from '../logger';
import { extractMessageText, truncateSummary } from './sessionDigest';

export interface SessionSnapshot {
  id: string;
  title: string;
  cwd: string;
  agentMode: string;
  /** Ultima actividad, en milisegundos. */
  lastActivityAt: number;
  lastRole: string;
  lastText: string;
  lastRowId: number;
  state: 'working' | 'idle';
}

export interface ReadSessionsOptions {
  limit?: number;
  withinMs?: number;
  workingWindowMs?: number;
}

/**
 * Lee las sesiones recientes de la base del CLI. Incluye las del IDE (Devin Desktop) y las
 * del CLI, porque comparten almacen: `backend_type` es `windsurf` en ambos casos.
 */
export function readSessions(dbPath: string, options: ReadSessionsOptions = {}): SessionSnapshot[] {
  if (!existsSync(dbPath)) return [];

  const limit = options.limit ?? 12;
  const withinMs = options.withinMs ?? 12 * 60 * 60 * 1000;
  const workingWindowMs = options.workingWindowMs ?? 60_000;
  const sinceSeconds = Math.floor((Date.now() - withinMs) / 1000);

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const rows = db
      .prepare(
        `SELECT id, title, working_directory, agent_mode, last_activity_at
           FROM sessions
          WHERE hidden = 0 AND last_activity_at >= ?
          ORDER BY last_activity_at DESC
          LIMIT ?`
      )
      .all(sinceSeconds, limit) as Array<{
      id: string;
      title: string;
      working_directory: string;
      agent_mode: string;
      last_activity_at: number;
    }>;

    const snapshots: SessionSnapshot[] = [];
    for (const row of rows) {
      const node = db
        .prepare('SELECT row_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id DESC LIMIT 1')
        .get(row.id) as { row_id: number; chat_message: string } | undefined;

      let role = '';
      let text = '';
      let rowId = 0;
      if (node) {
        rowId = Number(node.row_id);
        const message = extractMessageText(node.chat_message);
        role = message?.role ?? '';
        text = message?.text ?? '';
      }

      const lastActivityAt = Number(row.last_activity_at) * 1000;
      snapshots.push({
        id: row.id,
        title: row.title ?? '',
        cwd: row.working_directory ?? '',
        agentMode: row.agent_mode ?? '',
        lastActivityAt,
        lastRole: role,
        lastText: truncateSummary(text, 600),
        lastRowId: rowId,
        state: Date.now() - lastActivityAt < workingWindowMs ? 'working' : 'idle'
      });
    }
    return snapshots;
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

export interface SessionMonitorOptions {
  read?: () => SessionSnapshot[];
  /** Base de sesiones; se usa si no se inyecta `read`. */
  dbPath?: string;
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
 * Vigila las sesiones de Devin (IDE y CLI) para saber que se esta trabajando y avisar
 * cuando un turno termina. La primera lectura solo toma linea base: no notifica lo que
 * ya estaba terminado antes de arrancar el puente.
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
      const read = this.options.read ?? (() => readSessions(this.options.dbPath ?? '', {}));

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

/** Mensaje que recibe el usuario cuando una sesion de Devin termina su turno. */
export function formatFinishedSession(session: SessionSnapshot, now = Date.now()): string {
  const project = session.cwd ? session.cwd.split(/[\\/]/).filter(Boolean).pop() ?? session.cwd : 'sin carpeta';
  const idleFor = Math.max(0, Math.round((now - session.lastActivityAt) / 1000));
  const title = session.title.trim() || session.id;

  return [
    '✅ Sesion de Devin terminada',
    `Proyecto: ${project}`,
    `Sesion: ${title.length > 80 ? `${title.slice(0, 77)}...` : title}`,
    `Sin actividad desde hace ${idleFor}s`,
    '',
    'Resumen de lo ultimo que hizo:',
    session.lastText.trim() || '(sin texto)'
  ].join('\n');
}
