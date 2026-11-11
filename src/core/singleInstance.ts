import fs from 'node:fs/promises';
import path from 'node:path';

export interface LockInfo {
  pid: number;
  startedAt: number;
}

export interface AcquireResult {
  acquired: boolean;
  /** Proceso que ya tiene el candado, si se pudo leer. */
  holder?: LockInfo;
}

async function readLock(lockFile: string): Promise<LockInfo | null> {
  try {
    const raw = await fs.readFile(lockFile, 'utf8');
    const parsed = JSON.parse(raw) as LockInfo;
    return typeof parsed.pid === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM significa que existe pero no tenemos permiso para senalizarlo.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Candado por archivo con el PID. Evita que dos puentes hagan long polling con el mismo
 * token de Telegram (la API responde 409 Conflict y ambos pierden mensajes).
 * Si el candado es de un proceso muerto, se considera obsoleto y se sobrescribe.
 */
export async function acquireLock(lockFile: string): Promise<AcquireResult> {
  await fs.mkdir(path.dirname(lockFile), { recursive: true });

  const existing = await readLock(lockFile);
  if (existing && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    return { acquired: false, holder: existing };
  }

  const payload: LockInfo = { pid: process.pid, startedAt: Date.now() };
  await fs.writeFile(lockFile, JSON.stringify(payload), 'utf8');
  return { acquired: true };
}

export async function releaseLock(lockFile: string): Promise<void> {
  const current = await readLock(lockFile);
  if (current && current.pid !== process.pid) return;
  await fs.rm(lockFile, { force: true });
}
