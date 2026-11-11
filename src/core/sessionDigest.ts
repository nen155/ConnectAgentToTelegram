import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface SessionDigest {
  id: string;
  title: string;
  cwd: string;
  summary: string;
}

export interface SessionWindow {
  startedAtMs: number;
  finishedAtMs: number;
}

const MAX_SUMMARY_CHARS = 900;

/** Saca el texto de un `chat_message` (content puede ser string o lista de partes). */
export function extractMessageText(chatMessage: string): { role: string; text: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chatMessage);
  } catch {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : '';
  const content = record.content;

  if (typeof content === 'string') return { role, text: content };
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        const item = part as Record<string, unknown>;
        return typeof item.text === 'string' ? item.text : '';
      })
      .join(' ')
      .trim();
    return { role, text };
  }
  return null;
}

export function truncateSummary(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 3).trim()}...`;
}

/**
 * Busca la sesion que corresponde a una tarea externa recien terminada y devuelve su
 * ultimo mensaje del asistente. Es best-effort: si la base no existe, esta bloqueada o no
 * hay coincidencia, devuelve null y el aviso se manda sin resumen.
 */
export function readFinishedSession(dbPath: string, window: SessionWindow): SessionDigest | null {
  if (!existsSync(dbPath)) return null;

  const fromSeconds = Math.floor(window.startedAtMs / 1000) - 5;
  const toSeconds = Math.ceil(window.finishedAtMs / 1000) + 10;

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });

    const session = db
      .prepare(
        `SELECT id, title, working_directory, created_at, last_activity_at
           FROM sessions
          WHERE last_activity_at BETWEEN ? AND ?
            AND created_at >= ?
          ORDER BY last_activity_at DESC
          LIMIT 1`
      )
      .get(fromSeconds, toSeconds, fromSeconds) as
      | { id: string; title: string; working_directory: string }
      | undefined;

    if (!session) return null;

    const nodes = db
      .prepare('SELECT chat_message FROM message_nodes WHERE session_id = ? ORDER BY row_id DESC')
      .all(session.id) as Array<{ chat_message: string }>;

    for (const node of nodes) {
      const message = extractMessageText(node.chat_message);
      if (message?.role === 'assistant' && message.text.trim()) {
        return {
          id: session.id,
          title: session.title ?? '',
          cwd: session.working_directory ?? '',
          summary: truncateSummary(message.text)
        };
      }
    }

    return { id: session.id, title: session.title ?? '', cwd: session.working_directory ?? '', summary: '' };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
