import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/devin/sessionStore';

describe('SessionStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessions-'));
    file = path.join(dir, 'sessions.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('arranca vacio cuando el archivo no existe', async () => {
    const store = new SessionStore(file);
    await store.load();
    expect(store.get('123')).toBeUndefined();
  });

  it('guarda la sesion y la recupera tras recargar', async () => {
    const store = new SessionStore(file);
    await store.load();

    await store.record('123', { cwd: 'C:\\proyecto', sessionId: 'brisk-otter', lastPrompt: 'hola' });

    const reloaded = new SessionStore(file);
    await reloaded.load();

    const session = reloaded.get('123');
    expect(session).toMatchObject({ cwd: 'C:\\proyecto', sessionId: 'brisk-otter', runs: 1, lastPrompt: 'hola' });
  });

  it('conserva el sessionId previo si la ejecucion no devuelve uno nuevo', async () => {
    const store = new SessionStore(file);
    await store.load();

    await store.record('123', { cwd: 'C:\\proyecto', sessionId: 'brisk-otter' });
    await store.record('123', { cwd: 'C:\\proyecto' });

    expect(store.get('123')).toMatchObject({ sessionId: 'brisk-otter', runs: 2 });
  });

  it('reinicia el hilo eliminando la entrada', async () => {
    const store = new SessionStore(file);
    await store.load();
    await store.record('123', { cwd: 'C:\\proyecto', sessionId: 'brisk-otter' });

    await store.reset('123');

    expect(store.get('123')).toBeUndefined();
  });

  it('no corrompe el archivo con escrituras concurrentes', async () => {
    const store = new SessionStore(file);
    await store.load();

    await Promise.all([
      store.record('a', { cwd: 'x', sessionId: 'uno' }),
      store.record('b', { cwd: 'y', sessionId: 'dos' }),
      store.record('a', { cwd: 'x', sessionId: 'tres' })
    ]);

    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(Object.keys(raw).sort()).toEqual(['a', 'b']);
  });
});
