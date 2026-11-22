import {
  CommandError,
  runCommand,
  stripAnsi,
  tail,
  type CommandOptions,
  type CommandResult
} from '../../util/process';
import type { AgentCli, AgentRunRequest, AgentRunResult, CommandExecutor } from '../types';
import { findLatestOpenCodeSession } from './sessions';

export interface OpenCodeCliOptions {
  bin: string;
  model?: string;
  /** Agente configurado en OpenCode (`build`, `plan`...). */
  agent?: string;
  /** Equivale a `--dangerously-skip-permissions`. */
  skipPermissions: boolean;
  extraArgs: string[];
  /** Base de sesiones, para recuperar el id cuando el CLI no lo devuelve. */
  sessionsDb?: string;
  exec?: CommandExecutor;
}

/**
 * Argumentos de `opencode run`. Los flags van antes de `--`: lo que sigue al separador
 * es el mensaje, asi que una orden que empiece por `-` no se lee como flag.
 */
export function buildOpenCodeArgs(
  request: Pick<AgentRunRequest, 'prompt' | 'sessionId' | 'allowContinue'>,
  options: Pick<OpenCodeCliOptions, 'model' | 'agent' | 'skipPermissions' | 'extraArgs'>
): string[] {
  const args = ['run'];

  if (request.sessionId) args.push('--session', request.sessionId);
  else if (request.allowContinue) args.push('--continue');

  if (options.model) args.push('--model', options.model);
  if (options.agent) args.push('--agent', options.agent);
  if (options.skipPermissions) args.push('--dangerously-skip-permissions');

  args.push(...options.extraArgs);
  args.push('--', request.prompt);

  return args;
}

/** Quita ruido de la salida para que el resumen quede limpio en el chat. */
export function cleanOpenCodeOutput(stdout: string): string {
  return stripAnsi(stdout)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * OpenCode imprime algunos fallos en stdout y con codigo 0 (p. ej. "OpenCode 1.18.0
 * or newer is required to use the free tier"), asi que el codigo de salida no basta.
 */
export function friendlyOpenCodeError(text: string): string | null {
  if (/or newer is required to use the free tier/i.test(text)) {
    return [
      'OpenCode necesita una version mas nueva para el plan gratuito.',
      'Actualiza con `npm i -g opencode-ai` o inicia sesion con `opencode auth login`.'
    ].join('\n');
  }
  if (/no credentials|not logged in|unauthorized/i.test(text)) {
    return 'OpenCode no tiene credenciales. Ejecuta `opencode auth login` en esta PC.';
  }
  return null;
}

export class OpenCodeCli implements AgentCli {
  private readonly exec: CommandExecutor;

  constructor(private readonly options: OpenCodeCliOptions) {
    this.exec = options.exec ?? runCommand;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = buildOpenCodeArgs(request, this.options);
    const startedAt = Date.now();

    const result = await this.exec(this.options.bin, args, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      onSpawn: request.onSpawn
    });

    const durationMs = Date.now() - startedAt;
    const text = cleanOpenCodeOutput(result.stdout);

    if (result.timedOut) {
      throw new CommandError(
        `OpenCode supero el tiempo maximo (${Math.round(request.timeoutMs / 60000)} min).`,
        result
      );
    }

    if (result.code !== 0 && !text) {
      throw new CommandError(
        `OpenCode termino con codigo ${result.code}: ${tail(result.stderr || result.stdout)}`,
        result
      );
    }

    const friendly = friendlyOpenCodeError(`${text}\n${result.stderr}`);
    if (friendly) throw new CommandError(friendly, result);

    // OpenCode no imprime el id de la sesion: se toma de su base, la mas reciente de
    // esta carpeta. Si se reanudo una sesion, el id ya se conocia.
    const sessionId =
      request.sessionId ??
      (this.options.sessionsDb
        ? findLatestOpenCodeSession(this.options.sessionsDb, request.cwd, startedAt - 5_000)
        : undefined);

    return { text, sessionId, durationMs, exitCode: result.code };
  }
}

export type { CommandOptions, CommandResult };
