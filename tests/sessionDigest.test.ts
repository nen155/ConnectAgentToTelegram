import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractMessageText, readFinishedSession, truncateSummary } from '../src/core/sessionDigest';

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  working_directory TEXT,
  backend_type TEXT,
  model TEXT,
  agent_mode TEXT,
  created_at INTEGER,
  last_activity_at INTEGER,
  title TEXT,
  main_chain_id INTEGER,
  shell_last_seen_index INTEGER,
  cogs_json TEXT,
  workspace_dirs TEXT,
  hidden INTEGER,
  metadata TEXT
);
CREATE TABLE message_nodes (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  node_id INTEGER,
  parent_node_id INTEGER,
  chat_message TEXT,
  created_at INTEGER,
  metadata TEXT
);
`;

function buildDb(sessions: Array<Record<string, unknown>>, messages: Array<{ sessionId: string; role: string; text: string }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-db-'));
  const file = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  for (const session of sessions) {
    db.prepare(
      'INSERT INTO sessions (id, working_directory, created_at, last_activity_at, title) VALUES (?, ?, ?, ?, ?)'
    ).run(session.id as string, session.cwd as string, session.createdAt as number, session.lastActivity as number, session.title as string);
  }

  let node = 0;
  for (const message of messages) {
    db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message) VALUES (?, ?, ?)').run(
      message.sessionId,
      node++,
      JSON.stringify({ role: message.role, content: message.text })
    );
  }

  db.close();
  return file;
}

describe('extractMessageText', () => {
  it('lee content como texto', () => {
    expect(extractMessageText('{"role":"assistant","content":"hola"}')).toEqual({ role: 'assistant', text: 'hola' });
  });

  it('une content en formato de partes', () => {
    const raw = '{"role":"assistant","content":[{"text":"parte 1"},{"text":"parte 2"}]}';
    expect(extractMessageText(raw)).toEqual({ role: 'assistant', text: 'parte 1 parte 2' });
  });

  it('devuelve null si no es JSON', () => {
    expect(extractMessageText('no-json')).toBeNull();
  });
});

describe('truncateSummary', () => {
  it('recorta y anade puntos suspensivos', () => {
    const result = truncateSummary('x'.repeat(1000), 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('...')).toBe(true);
  });
});

describe('readFinishedSession', () => {
  it('encuentra la sesion de la ventana y devuelve el ultimo mensaje del asistente', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const file = buildDb(
      [{ id: 'brisk-otter', cwd: 'C:\\proyecto', createdAt: nowSeconds - 60, lastActivity: nowSeconds - 10, title: 'Arreglar login' }],
      [
        { sessionId: 'brisk-otter', role: 'user', text: 'arregla el login' },
        { sessionId: 'brisk-otter', role: 'assistant', text: 'Arreglado: cambie auth.ts y anadi un test.' }
      ]
    );

    const digest = readFinishedSession(file, {
      startedAtMs: Date.now() - 70_000,
      finishedAtMs: Date.now() - 5_000
    });

    expect(digest).toMatchObject({ id: 'brisk-otter', title: 'Arreglar login' });
    expect(digest?.summary).toContain('Arreglado');
  });

  it('elige la sesion mas reciente dentro de la ventana', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const file = buildDb(
      [
        { id: 'vieja', cwd: 'x', createdAt: nowSeconds - 500, lastActivity: nowSeconds - 400, title: 'vieja' },
        { id: 'nueva', cwd: 'y', createdAt: nowSeconds - 50, lastActivity: nowSeconds - 5, title: 'nueva' }
      ],
      [
        { sessionId: 'vieja', role: 'assistant', text: 'resumen viejo' },
        { sessionId: 'nueva', role: 'assistant', text: 'resumen nuevo' }
      ]
    );

    const digest = readFinishedSession(file, { startedAtMs: Date.now() - 80_000, finishedAtMs: Date.now() });

    expect(digest?.id).toBe('nueva');
    expect(digest?.summary).toBe('resumen nuevo');
  });

  it('devuelve null si la base no existe', () => {
    expect(readFinishedSession(path.join(os.tmpdir(), 'no-existe-123.db'), { startedAtMs: 0, finishedAtMs: 1 })).toBeNull();
  });

  it('devuelve null si no hay sesiones en la ventana', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const file = buildDb(
      [{ id: 'antigua', cwd: 'x', createdAt: nowSeconds - 5000, lastActivity: nowSeconds - 4000, title: 'antigua' }],
      [{ sessionId: 'antigua', role: 'assistant', text: 'hola' }]
    );

    expect(readFinishedSession(file, { startedAtMs: Date.now() - 1000, finishedAtMs: Date.now() })).toBeNull();
  });
});
