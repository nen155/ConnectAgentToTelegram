import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLogger } from '../src/logger';
import { formatFinishedSession, readSessions, SessionMonitor, type SessionSnapshot } from '../src/core/sessionMonitor';

const logger = createLogger({ level: 'error' });

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

function buildDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-monitor-'));
  const file = path.join(dir, 'sessions.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);

  const nowSeconds = Math.floor(Date.now() / 1000);
  db.prepare(
    'INSERT INTO sessions (id, working_directory, created_at, last_activity_at, title, hidden) VALUES (?, ?, ?, ?, ?, 0)'
  ).run('visual-hacksaw', 'I:\\Juegos\\Silver', nowSeconds - 600, nowSeconds - 10, 'Pasar contenido a la web');
  db.prepare(
    'INSERT INTO sessions (id, working_directory, created_at, last_activity_at, title, hidden) VALUES (?, ?, ?, ?, ?, 0)'
  ).run('antigua', 'C:\\x', nowSeconds - 90_000, nowSeconds - 80_000, 'Vieja');

  db.prepare('INSERT INTO message_nodes (session_id, node_id, chat_message) VALUES (?, ?, ?)').run(
    'visual-hacksaw',
    0,
    JSON.stringify({ role: 'assistant', content: 'Estoy convirtiendo los SMK a webm.' })
  );
  db.close();
  return file;
}

describe('readSessions', () => {
  it('lee las sesiones recientes con su ultimo mensaje', () => {
    const file = buildDb();
    const sessions = readSessions(file, { limit: 5, withinMs: 60 * 60 * 1000 });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'visual-hacksaw',
      title: 'Pasar contenido a la web',
      cwd: 'I:\\Juegos\\Silver',
      lastRole: 'assistant'
    });
    expect(sessions[0]?.lastText).toContain('SMK');
  });

  it('marca como working lo que tiene actividad reciente', () => {
    const file = buildDb();
    const sessions = readSessions(file, { limit: 5, workingWindowMs: 60_000 });
    expect(sessions[0]?.state).toBe('working');

    const strict = readSessions(file, { limit: 5, workingWindowMs: 1_000 });
    expect(strict[0]?.state).toBe('idle');
  });

  it('devuelve lista vacia si la base no existe', () => {
    expect(readSessions(path.join(os.tmpdir(), 'no-existe-sesiones.db'))).toEqual([]);
  });
});

function snapshot(patch: Partial<SessionSnapshot>): SessionSnapshot {
  return {
    id: 'visual-hacksaw',
    title: 'Pasar contenido a la web',
    cwd: 'I:\\Juegos\\Silver',
    agentMode: 'bypass',
    lastActivityAt: Date.now(),
    lastRole: 'assistant',
    lastText: 'hola',
    lastRowId: 1,
    state: 'working',
    ...patch
  };
}

describe('SessionMonitor', () => {
  it('no avisa de lo que ya estaba terminado al arrancar', async () => {
    const finished: string[] = [];
    const monitor = new SessionMonitor({
      read: () => [snapshot({ lastText: 'terminado antes de arrancar' })],
      onFinished: (session) => finished.push(session.id),
      logger
    });

    await monitor.poll();
    expect(finished).toEqual([]);
  });

  it('avisa una sola vez cuando el turno termina tras cambiar el contenido', async () => {
    const finished: string[] = [];
    let now = 1_000_000;
    let current = snapshot({ lastText: 'primera', lastActivityAt: now, lastRowId: 1 });

    const monitor = new SessionMonitor({
      read: () => [current],
      onFinished: (session) => finished.push(session.lastText),
      logger,
      settleMs: 20_000,
      now: () => now
    });

    await monitor.poll();

    now += 5_000;
    current = snapshot({ lastText: 'segunda', lastActivityAt: now, lastRowId: 2 });
    await monitor.poll();
    expect(finished).toEqual([]);

    now += 30_000;
    await monitor.poll();
    expect(finished).toEqual(['segunda']);

    now += 30_000;
    await monitor.poll();
    expect(finished).toEqual(['segunda']);
  });

  it('respeta las sesiones que gestiona el propio puente', async () => {
    const finished: string[] = [];
    let now = 1_000_000;
    let current = snapshot({ id: 'vine-opera', lastText: 'a', lastActivityAt: now, lastRowId: 1 });

    const monitor = new SessionMonitor({
      read: () => [current],
      onFinished: (session) => finished.push(session.id),
      ignoreIds: () => new Set(['vine-opera']),
      logger,
      settleMs: 1_000,
      now: () => now
    });

    await monitor.poll();
    now += 10_000;
    current = snapshot({ id: 'vine-opera', lastText: 'b', lastActivityAt: now - 5_000, lastRowId: 2 });
    await monitor.poll();

    expect(finished).toEqual([]);
  });

  it('no avisa si el ultimo mensaje esta vacio (sigue generando)', async () => {
    const finished: string[] = [];
    let now = 1_000_000;
    let current = snapshot({ lastText: 'a', lastActivityAt: now, lastRowId: 1 });

    const monitor = new SessionMonitor({
      read: () => [current],
      onFinished: (session) => finished.push(session.id),
      logger,
      settleMs: 1_000,
      now: () => now
    });

    await monitor.poll();
    now += 10_000;
    current = snapshot({ lastText: '', lastActivityAt: now - 5_000, lastRowId: 2 });
    await monitor.poll();
    now += 10_000;
    await monitor.poll();

    expect(finished).toEqual([]);
  });

  it('publica las sesiones para el panel', async () => {
    const monitor = new SessionMonitor({
      read: () => [snapshot({})],
      onFinished: () => undefined,
      logger
    });

    await monitor.poll();
    expect(monitor.sessions()).toHaveLength(1);
  });
});

describe('formatFinishedSession', () => {
  it('incluye proyecto, titulo y resumen', () => {
    const text = formatFinishedSession(
      snapshot({ title: 'Pasar contenido a la web', lastText: 'Converti los SMK a webm.', lastActivityAt: Date.now() - 30_000 })
    );

    expect(text).toContain('Sesion de Devin terminada');
    expect(text).toContain('Silver');
    expect(text).toContain('Pasar contenido a la web');
    expect(text).toContain('Converti los SMK');
  });
});
