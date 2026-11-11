import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import type { AgentSessions, ReadSessionsOptions, SessionSnapshot } from '../types';

/** Base de sesiones por defecto de OpenCode en Windows/Linux/macOS. */
export function defaultOpenCodeDb(home = process.env.USERPROFILE ?? process.env.HOME ?? ''): string {
  return path.join(home, '.local', 'share', 'opencode', 'opencode.db');
}

interface SessionRow {
  id: string;
  title: string;
  directory: string;
  time_updated: number;
}

interface PartRow {
  id: string;
  time_created: number;
  data: string;
}

function normalizeCwd(value: string): string {
  return value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/**
 * Lee el texto de una `part` de OpenCode: `data` es JSON y solo interesa el texto.
 * Las partes de herramientas (`tool`, `step-start`...) no son respuesta del agente.
 */
function partText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { type?: string; text?: string };
    return parsed.type === 'text' && typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

/**
 * Sesiones recientes de OpenCode (TUI y CLI escriben en la misma base).
 * `session.directory` es la carpeta del proyecto; el texto vive en `part` y el rol en
 * `message.data`.
 */
export function readOpenCodeSessions(dbPath: string, options: ReadSessionsOptions = {}): SessionSnapshot[] {
  if (!dbPath || !existsSync(dbPath)) return [];

  const limit = options.limit ?? 12;
  const withinMs = options.withinMs ?? 12 * 60 * 60 * 1000;
  const workingWindowMs = options.workingWindowMs ?? 60_000;
  const since = Date.now() - withinMs;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const rows = db
      .prepare(
        `SELECT id, title, directory, time_updated
           FROM session
          WHERE parent_id IS NULL AND time_updated >= ?
          ORDER BY time_updated DESC
          LIMIT ?`
      )
      .all(since, limit) as unknown as SessionRow[];

    const snapshots: SessionSnapshot[] = [];
    for (const row of rows) {
      const part = db
        .prepare(
          `SELECT p.id, p.time_created, p.data
             FROM part p
             JOIN message m ON m.id = p.message_id
            WHERE p.session_id = ?
              AND json_extract(p.data, '$.type') = 'text'
              AND json_extract(m.data, '$.role') = 'assistant'
            ORDER BY p.time_created DESC
            LIMIT 1`
        )
        .get(row.id) as unknown as PartRow | undefined;

      const text = part ? partText(part.data) : '';
      const lastActivityAt = Number(row.time_updated);
      snapshots.push({
        id: row.id,
        title: row.title ?? '',
        cwd: row.directory ?? '',
        agentMode: '',
        lastActivityAt,
        lastRole: text ? 'assistant' : '',
        lastText: text,
        lastRowId: part ? Number(part.time_created) : 0,
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

/**
 * Id de la sesion mas reciente de esa carpeta. Se usa cuando el CLI no devuelve el id:
 * OpenCode lo escribe en su base al arrancar el turno.
 */
export function findLatestOpenCodeSession(
  dbPath: string,
  cwd: string,
  sinceMs: number
): string | undefined {
  if (!dbPath || !existsSync(dbPath)) return undefined;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare('SELECT id, directory FROM session WHERE time_updated >= ? ORDER BY time_updated DESC LIMIT 20')
      .all(sinceMs) as unknown as Array<{ id: string; directory: string }>;

    const target = normalizeCwd(cwd);
    return rows.find((row) => normalizeCwd(row.directory ?? '') === target)?.id;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

export class OpenCodeSessions implements AgentSessions {
  constructor(private readonly dbPath: string) {}

  read(options: ReadSessionsOptions = {}): SessionSnapshot[] {
    return readOpenCodeSessions(this.dbPath, options);
  }
}
