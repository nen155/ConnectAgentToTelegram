import { spawn } from 'node:child_process';

const MAX_CAPTURED_CHARS = 2_000_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface CommandOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export class CommandError extends Error {
  constructor(message: string, readonly result: CommandResult) {
    super(message);
    this.name = 'CommandError';
  }
}

function appendCapped(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_CAPTURED_CHARS ? next.slice(next.length - MAX_CAPTURED_CHARS) : next;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // El proceso ya habia terminado.
  }
}

/**
 * Ejecuta un binario sin shell (sin interpolacion de argumentos) y captura su salida.
 * Nunca rechaza por codigo de salida: eso lo decide cada llamador con assertSuccess.
 */
export function runCommand(bin: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child.pid);
        }, options.timeoutMs)
      : undefined;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    child.stdout?.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
      options.onStdout?.(chunk);
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
      options.onStderr?.(chunk);
    });

    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`No se pudo ejecutar "${bin}": ${error.message}`));
    });

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

export function tail(text: string, maxChars = 400): string {
  const clean = text.trim();
  return clean.length <= maxChars ? clean : `...${clean.slice(clean.length - maxChars)}`;
}

export function assertSuccess(result: CommandResult, label: string): void {
  if (result.timedOut) {
    throw new CommandError(`${label}: tiempo de espera agotado`, result);
  }
  if (result.code !== 0) {
    throw new CommandError(`${label} fallo (codigo ${result.code}): ${tail(result.stderr || result.stdout)}`, result);
  }
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}
