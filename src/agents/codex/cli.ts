import { CommandError, runCommand, stripAnsi, tail } from '../../util/process';
import type { AgentCli, AgentRunRequest, AgentRunResult, CommandExecutor } from '../types';
import { findLatestCodexSession } from './sessions';

export interface CodexCliOptions {
  bin: string;
  model?: string;
  /** `--full-auto`: no pide aprobacion (equivale al modo dangerous de Devin). */
  fullAuto: boolean;
  /** `--skip-git-repo-check`: permite trabajar en carpetas que no son un repo git. */
  skipGitRepoCheck: boolean;
  extraArgs: string[];
  /** Carpeta de rollouts, para recuperar el id de sesion. */
  sessionsDir?: string;
  exec?: CommandExecutor;
}

/**
 * Argumentos de `codex exec`. Los flags van entre `exec` y `resume`: el parser de Codex
 * no los acepta despues del subcomando de reanudacion. El prompt va tras `--` para que
 * una orden que empiece por `-` no se lea como flag.
 */
export function buildCodexArgs(
  request: Pick<AgentRunRequest, 'prompt' | 'sessionId' | 'allowContinue'>,
  options: Pick<CodexCliOptions, 'model' | 'fullAuto' | 'skipGitRepoCheck' | 'extraArgs'>
): string[] {
  const args = ['exec'];

  if (options.model) args.push('--model', options.model);
  if (options.fullAuto) args.push('--full-auto');
  if (options.skipGitRepoCheck) args.push('--skip-git-repo-check');
  args.push(...options.extraArgs);

  if (request.sessionId) args.push('resume', request.sessionId);
  else if (request.allowContinue) args.push('resume', '--last');

  args.push('--', request.prompt);

  return args;
}

export function cleanCodexOutput(stdout: string): string {
  return stripAnsi(stdout)
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class CodexCli implements AgentCli {
  private readonly exec: CommandExecutor;

  constructor(private readonly options: CodexCliOptions) {
    this.exec = options.exec ?? runCommand;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = buildCodexArgs(request, this.options);
    const startedAt = Date.now();

    const result = await this.exec(this.options.bin, args, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs
    });

    const durationMs = Date.now() - startedAt;
    const text = cleanCodexOutput(result.stdout);

    if (result.timedOut) {
      throw new CommandError(
        `Codex supero el tiempo maximo (${Math.round(request.timeoutMs / 60000)} min).`,
        result
      );
    }

    if (result.code !== 0 && !text) {
      throw new CommandError(
        `Codex termino con codigo ${result.code}: ${tail(result.stderr || result.stdout)}`,
        result
      );
    }

    // `codex exec` no imprime el id: se toma del rollout mas reciente de esa carpeta.
    const sessionId =
      request.sessionId ??
      (this.options.sessionsDir
        ? findLatestCodexSession(this.options.sessionsDir, request.cwd, startedAt - 5_000)
        : undefined);

    return { text, sessionId, durationMs, exitCode: result.code };
  }
}
