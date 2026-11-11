import fs from 'node:fs';
import path from 'node:path';
import type { AgentSessions, ReadSessionsOptions, SessionSnapshot } from '../types';

/** Carpeta por defecto de las sesiones de Claude Code. */
export function defaultClaudeProjectsDir(home = process.env.USERPROFILE ?? process.env.HOME ?? ''): string {
  return path.join(home, '.claude', 'projects');
}

interface TranscriptLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

function listTranscripts(dir: string, limit: number): Array<{ file: string; mtimeMs: number }> {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(dir, entry.name);
    let files: string[];
    try {
      files = fs.readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of files) {
      const full = path.join(projectDir, name);
      try {
        found.push({ file: full, mtimeMs: fs.statSync(full).mtimeMs });
      } catch {
        // Archivo borrado mientras se leia: se ignora.
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function parseTranscript(file: string): TranscriptLine[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TranscriptLine;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

/** Texto de un mensaje del asistente (`message.content` puede ser cadena o bloques). */
function assistantText(line: TranscriptLine): string {
  if (line.type !== 'assistant' && line.message?.role !== 'assistant') return '';
  const content = line.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      const record = item as Record<string, unknown>;
      return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
    })
    .join('')
    .trim();
}

/**
 * Sesiones recientes de Claude Code: un `.jsonl` por sesion bajo
 * `~/.claude/projects/<proyecto>/<session-id>.jsonl`.
 */
export function readClaudeSessions(dir: string, options: ReadSessionsOptions = {}): SessionSnapshot[] {
  const limit = options.limit ?? 12;
  const withinMs = options.withinMs ?? 12 * 60 * 60 * 1000;
  const workingWindowMs = options.workingWindowMs ?? 60_000;
  const since = Date.now() - withinMs;

  const files = listTranscripts(dir, Math.max(limit * 3, 20)).filter((entry) => entry.mtimeMs >= since);
  const snapshots: SessionSnapshot[] = [];

  for (const entry of files.slice(0, limit)) {
    const lines = parseTranscript(entry.file);
    const first = lines.find((line) => line.sessionId || line.cwd) ?? {};

    let text = '';
    let rowId = 0;
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index];
      if (!line) continue;
      const candidate = assistantText(line);
      if (!candidate) continue;
      text = candidate;
      rowId = index + 1;
      break;
    }

    snapshots.push({
      id: first.sessionId ?? path.basename(entry.file, '.jsonl'),
      title: '',
      cwd: first.cwd ?? '',
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

/** Id de la sesion mas reciente de esa carpeta, para poder reanudarla. */
export function findLatestClaudeSession(dir: string, cwd: string, sinceMs: number): string | undefined {
  const normalize = (value: string): string => value.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
  const target = normalize(cwd);

  for (const entry of listTranscripts(dir, 30)) {
    if (entry.mtimeMs < sinceMs) continue;
    const first = parseTranscript(entry.file).find((line) => line.sessionId || line.cwd);
    if (!first?.cwd || normalize(first.cwd) !== target) continue;
    return first.sessionId ?? path.basename(entry.file, '.jsonl');
  }
  return undefined;
}

export class ClaudeSessions implements AgentSessions {
  constructor(private readonly dir: string) {}

  read(options: ReadSessionsOptions = {}): SessionSnapshot[] {
    return readClaudeSessions(this.dir, options);
  }
}
