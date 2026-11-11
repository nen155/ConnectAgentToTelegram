import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { AgentSessions, ReadSessionsOptions, SessionSnapshot } from '../types';
import { extractMessageText, summarizeMessage } from '../../core/sessionDigest';

/**
 * Lee las sesiones recientes de la base del CLI de Devin. Incluye las del IDE
 * (Devin Desktop) y las del CLI, porque comparten almacen: `backend_type` es
 * `windsurf` en ambos casos.
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
      // Se busca el ultimo mensaje DEL ASISTENTE con texto: el ultimo nodo puede ser un
      // mensaje interno (p. ej. la instruccion de resumir la conversacion), que no es la
      // respuesta del agente y llegaria a Telegram en otro idioma y fuera de contexto.
      const nodes = db
        .prepare(
          'SELECT row_id, chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id DESC LIMIT 8'
        )
        .all(row.id) as Array<{ row_id: number; chat_message: string }>;

      let role = '';
      let text = '';
      let rowId = 0;
      for (const node of nodes) {
        const message = extractMessageText(node.chat_message);
        if (!message || message.role !== 'assistant') continue;
        if (!message.text.trim()) continue;
        role = message.role;
        text = message.text;
        rowId = Number(node.row_id);
        break;
      }

      const lastActivityAt = Number(row.last_activity_at) * 1000;
      snapshots.push({
        id: row.id,
        title: row.title ?? '',
        cwd: row.working_directory ?? '',
        agentMode: row.agent_mode ?? '',
        lastActivityAt,
        lastRole: role,
        lastText: summarizeMessage(text),
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

/** Adaptador del puerto de sesiones para Devin (CLI y Devin Desktop comparten base). */
export class DevinSessions implements AgentSessions {
  constructor(private readonly dbPath: string) {}

  read(options: ReadSessionsOptions = {}): SessionSnapshot[] {
    return readSessions(this.dbPath, options);
  }
}
