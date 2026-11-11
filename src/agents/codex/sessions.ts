import fs from 'node:fs';
import path from 'node:path';
import type { AgentSessions, ReadSessionsOptions, SessionSnapshot } from '../types';

/** Carpeta por defecto de las sesiones de Codex. */
export function defaultCodexSessionsDir(home = process.env.USERPROFILE ?? process.env.HOME ?? ''): string {
  return path.join(home, '.codex', 'sessions');
}

interface RolloutFile {
  file: string;
  mtimeMs: number;
}

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

function listRollouts(dir: string, limit: number): RolloutFile[] {
  const found: RolloutFile[] = [];
  const walk = (current: string, depth: number): void => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      try {
        found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        // Archivo borrado mientras se leia: se ignora.
      }
    }
  };
  walk(dir, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function parseLines(file: string): CodexLine[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as CodexLine;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

/** Texto de un mensaje del asistente en el formato de rollouts de Codex. */
function assistantText(line: CodexLine): string {
  const payload = line.payload ?? {};

  // Evento resumido que emite `codex exec`.
  if (line.type === 'event_msg' && payload.type === 'agent_message' && typeof payload.message === 'string') {
    return payload.message;
  }

  // Item de conversacion completo.
  if (payload.type === 'message' && payload.role === 'assistant') {
    const content = payload.content;
    if (Array.isArray(content)) {
      return content
        .map((item) => {
          const record = item as Record<string, unknown>;
          return typeof record.text === 'string' ? record.text : '';
        })
        .join('')
        .trim();
    }
  }

  return '';
}

/**
 * Sesiones recientes de Codex. Cada sesion es un `.jsonl` bajo `~/.codex/sessions`;
 * la primera linea (`session_meta`) trae id y carpeta, y las siguientes, los mensajes.
 */
export function readCodexSessions(dir: string, options: ReadSessionsOptions = {}): SessionSnapshot[] {
  const limit = options.limit ?? 12;
  const withinMs = options.withinMs ?? 12 * 60 * 60 * 1000;
  const workingWindowMs = options.workingWindowMs ?? 60_000;
  const since = Date.now() - withinMs;

  const files = listRollouts(dir, Math.max(limit * 3, 20)).filter((entry) => entry.mtimeMs >= since);
  const snapshots: SessionSnapshot[] = [];

  for (const entry of files.slice(0, limit)) {
    const lines = parseLines(entry.file);
    const meta = lines.find((line) => line.type === 'session_meta');
    const payload = (meta?.payload ?? {}) as Record<string, unknown>;

    const id = typeof payload.id === 'string' ? payload.id : path.basename(entry.file, '.jsonl');
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';

    let text = '';
    let rowId = 0;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line) continue;
      const candidate = assistantText(line);
      if (!candidate.trim()) continue;
      text = candidate;
      rowId = index + 1;
      break;
    }

    snapshots.push({
      id,
      title: '',
      cwd,
      agentMode: '',
      lastActivityAt: entry.mtimeMs,
      lastRole: text ? 'assistant' : '',
      lastText: text,
      lastRowId: rowId,
      state: Date.now() - entry.mtimeMs < workingWindowMs ? 'working' : 'idle'
    });
  }

  return snapshots;
}

/** Id de la sesion mas reciente de esa carpeta, para guardarlo y poder reanudarla. */
export function findLatestCodexSession(dir: string, cwd: string, sinceMs: number): string | undefined {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const target = normalize(cwd);

  for (const entry of listRollouts(dir, 30)) {
    if (entry.mtimeMs < sinceMs) continue;
    const meta = parseLines(entry.file).find((line) => line.type === 'session_meta');
    const payload = (meta?.payload ?? {}) as Record<string, unknown>;
    if (typeof payload.cwd !== 'string') continue;
    if (normalize(payload.cwd) !== target) continue;
    return typeof payload.id === 'string' ? payload.id : path.basename(entry.file, '.jsonl');
  }
  return undefined;
}

export class CodexSessions implements AgentSessions {
  constructor(private readonly dir: string) {}

  read(options: ReadSessionsOptions = {}): SessionSnapshot[] {
    return readCodexSessions(this.dir, options);
  }
}
