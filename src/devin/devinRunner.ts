import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CommandError, runCommand, stripAnsi, tail, type CommandOptions, type CommandResult } from '../util/process';
import { devinEnv } from './env';

export type CommandExecutor = (bin: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export interface DevinRunRequest {
  prompt: string;
  /** Sesion a reanudar. Tiene prioridad sobre `allowContinue`. */
  sessionId?: string;
  /** true si ya se ejecuto algo en este directorio y se puede usar --continue. */
  allowContinue: boolean;
  cwd: string;
  timeoutMs: number;
}

export interface DevinRunResult {
  text: string;
  sessionId?: string;
  durationMs: number;
  exitCode: number;
}

export interface DevinRunnerOptions {
  bin: string;
  permissionMode: string;
  model?: string;
  extraArgs: string[];
  tmpDir: string;
  /** Inyectable para pruebas; por defecto ejecuta procesos reales. */
  exec?: CommandExecutor;
}

const SESSION_KEYS = /^(session_?id|trajectory_?id|conversation_?id|thread_?id)$/i;

/**
 * Construye los argumentos del CLI. Aislado para poder probarlo sin lanzar procesos.
 * Los flags van ANTES de `--`: todo lo que sigue al separador es posicional, asi que
 * un flag despues del prompt se interpretaria como texto de la orden.
 */
export function buildDevinArgs(
  request: Pick<DevinRunRequest, 'prompt' | 'sessionId' | 'allowContinue'>,
  options: Pick<DevinRunnerOptions, 'permissionMode' | 'model' | 'extraArgs'>,
  exportFile: string
): string[] {
  const args: string[] = [];

  if (request.sessionId) {
    args.push('--resume', request.sessionId);
  } else if (request.allowContinue) {
    args.push('--continue');
  }

  args.push('--permission-mode', options.permissionMode);
  args.push('--respect-workspace-trust', 'false');
  args.push('--export', exportFile);

  if (options.model) args.push('--model', options.model);
  args.push(...options.extraArgs);

  args.push('--print', '--', request.prompt);

  return args;
}

/** Busca un identificador de sesion en el export ATIF o en la salida del CLI. */
export function extractSessionId(source: unknown, depth = 0): string | undefined {
  if (depth > 3 || source === null || typeof source !== 'object') return undefined;

  if (Array.isArray(source)) {
    for (const item of source) {
      const found = extractSessionId(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }

  const record = source as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (SESSION_KEYS.test(key) && typeof value === 'string' && value.trim().length >= 4) {
      return value.trim();
    }
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const found = extractSessionId(value, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

export function extractSessionIdFromOutput(output: string): string | undefined {
  const match = /(?:session(?:\s+id)?|reanudar|resume)\s*[:=]\s*([a-z0-9][a-z0-9_-]{3,})/i.exec(output);
  return match?.[1];
}

/** Quita ruido de la salida para que el resumen quede limpio en el chat. */
export function cleanDevinOutput(stdout: string): string {
  return stripAnsi(stdout)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function friendlyDevinError(stderr: string, stdout: string): string | null {
  const combined = `${stdout}\n${stderr}`;
  if (/not logged in|no has iniciado sesion|devin auth login/i.test(combined)) {
    return 'Devin CLI no tiene sesion iniciada en esta PC. Ejecuta `devin auth login` una vez y vuelve a intentarlo.';
  }
  if (/untrusted workspace|workspace trust/i.test(combined)) {
    return [
      'La carpeta de trabajo no esta marcada como confiable para Devin.',
      'Arreglalo de una de estas dos formas:',
      '  1) ejecuta `devin` una vez en esa carpeta y acepta el aviso de confianza, o',
      '  2) crea `.devin/config.local.json` con {"respect_workspace_trust": false}.'
    ].join('\n');
  }
  if (/usage limit|quota|rate limit/i.test(combined)) {
    return 'Se alcanzo el limite de uso de Devin. Espera un rato o cambia de modelo.';
  }
  return null;
}

export class DevinRunner {
  private authCheckedAt = 0;
  private authOk = false;
  private readonly exec: CommandExecutor;

  constructor(private readonly options: DevinRunnerOptions) {
    this.exec = options.exec ?? runCommand;
  }

  /**
   * Sin sesion iniciada, `devin -p` se queda esperando el flujo de login y no
   * devuelve nada: mejor detectarlo antes de lanzar la orden.
   */
  private async ensureAuthenticated(): Promise<void> {
    if (Date.now() - this.authCheckedAt < 60_000) {
      if (!this.authOk) throw new Error('Devin CLI no tiene sesion iniciada. Ejecuta `devin auth login` en esta PC.');
      return;
    }

    const result = await this.exec(this.options.bin, ['auth', 'status'], { timeoutMs: 20_000, env: devinEnv() });
    const output = `${result.stdout}\n${result.stderr}`;
    this.authOk = result.code === 0 && !/not logged in/i.test(output);
    this.authCheckedAt = Date.now();

    if (!this.authOk) {
      throw new Error('Devin CLI no tiene sesion iniciada. Ejecuta `devin auth login` en esta PC.');
    }
  }

  async run(request: DevinRunRequest): Promise<DevinRunResult> {
    await this.ensureAuthenticated();

    const exportFile = path.join(this.options.tmpDir, `export-${randomUUID()}.json`);
    const args = buildDevinArgs(request, this.options, exportFile);
    const startedAt = Date.now();

    const result = await this.exec(this.options.bin, args, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      env: devinEnv()
    });

    const durationMs = Date.now() - startedAt;
    const stdout = cleanDevinOutput(result.stdout);
    const sessionId = await this.readSessionId(exportFile, `${result.stdout}\n${result.stderr}`);
    await fs.rm(exportFile, { force: true });

    if (result.timedOut) {
      throw new CommandError(
        `Devin supero el tiempo maximo (${Math.round(request.timeoutMs / 60000)} min).`,
        result
      );
    }

    const friendly = friendlyDevinError(result.stderr, result.stdout);
    if (friendly) throw new CommandError(friendly, result);

    if (result.code !== 0 && !stdout) {
      throw new CommandError(`Devin termino con codigo ${result.code}: ${tail(result.stderr || result.stdout)}`, result);
    }

    return { text: stdout, sessionId, durationMs, exitCode: result.code };
  }

  private async readSessionId(exportFile: string, rawOutput: string): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(exportFile, 'utf8');
      const fromExport = extractSessionId(JSON.parse(raw));
      if (fromExport) return fromExport;
    } catch {
      // El export es opcional: si no existe seguimos con la salida de texto.
    }
    return extractSessionIdFromOutput(rawOutput);
  }
}
