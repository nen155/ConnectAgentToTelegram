import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { acquireLock, isProcessAlive, releaseLock } from '../src/core/singleInstance';

describe('singleInstance', () => {
  let dir: string;
  let lockFile: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-'));
    lockFile = path.join(dir, 'bridge.lock');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('adquiere el candado y escribe el PID', async () => {
    const result = await acquireLock(lockFile);
    expect(result.acquired).toBe(true);

    const written = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    expect(written.pid).toBe(process.pid);
  });

  it('rechaza la segunda instancia si el titular sigue vivo', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: 'ignore' });
    try {
      await fs.writeFile(lockFile, JSON.stringify({ pid: child.pid, startedAt: Date.now() }), 'utf8');

      const result = await acquireLock(lockFile);

      expect(result.acquired).toBe(false);
      expect(result.holder?.pid).toBe(child.pid);
    } finally {
      child.kill();
    }
  });

  it('ignora un candado obsoleto de un proceso muerto', async () => {
    await fs.writeFile(lockFile, JSON.stringify({ pid: 999_999, startedAt: Date.now() }), 'utf8');

    const result = await acquireLock(lockFile);

    expect(result.acquired).toBe(true);
    const written = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    expect(written.pid).toBe(process.pid);
  });

  it('tolera un candado corrupto', async () => {
    await fs.writeFile(lockFile, 'no-es-json', 'utf8');

    await expect(acquireLock(lockFile)).resolves.toMatchObject({ acquired: true });
  });

  it('libera solo su propio candado', async () => {
    await acquireLock(lockFile);
    await releaseLock(lockFile);
    await expect(fs.access(lockFile)).rejects.toThrow();

    await fs.writeFile(lockFile, JSON.stringify({ pid: 999_999, startedAt: Date.now() }), 'utf8');
    await releaseLock(lockFile);
    await expect(fs.access(lockFile)).resolves.toBeUndefined();
  });

  it('detecta procesos vivos y muertos', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(999_999)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });
});
