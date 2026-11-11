import { CommandError, runCommand, stripAnsi, tail } from '../../util/process';
import type { AgentCli, AgentRunRequest, AgentRunResult, CommandExecutor } from '../types';
import { findLatestClaudeSession } from './sessions';

export type ClaudePermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

export interface ClaudeCliOptions {
  bin: string;
  model?: string;
  permissionMode: ClaudePermissionMode;
  extraArgs: string[];
  /** Carpeta de transcripciones, para recuperar el id de sesion. */
  projectsDir?: string;
  exec?: CommandExecutor;
}

/**
 * Argumentos de Claude Code en modo headless (`-p`). El prompt va al final como
 * posicional; `--` evita que una orden que empiece por `-` se lea como flag.
 */
export function buildClaudeArgs(
  request: Pick<AgentRunRequest, 'prompt' | 'sessionId' | 'allowContinue'>,
  options: Pick<ClaudeCliOptions, 'model' | 'permissionMode' | 'extraArgs'>
): string[] {
  const args = ['-p', '--output-format', 'json'];

  if (request.sessionId) args.push('--resume', request.sessionId);
  else if (request.allowContinue) args.push('--continue');

  if (options.model) args.push('--model', options.model);
  args.push('--permission-mode', options.permissionMode);
  args.push(...options.extraArgs);
  args.push('--', request.prompt);

  return args;
}

export interface ClaudeJsonOutput {
  text: string;
  sessionId?: string;
  isError: boolean;
}

/**
 * Con `--output-format json` Claude Code imprime un objeto con `result` y `session_id`.
 * Si la salida no es JSON (version distinta o error de arranque), se usa tal cual.
 */
export function parseClaudeOutput(stdout: string): ClaudeJsonOutput {
  const clean = stripAnsi(stdout).trim();
  try {
    const parsed = JSON.parse(clean) as Record<string, unknown>;
    const text = typeof parsed.result === 'string' ? parsed.result : '';
    const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : undefined;
    const isError = parsed.is_error === true || parsed.subtype === 'error';
    return { text: text.trim(), sessionId, isError };
  } catch {
    return { text: clean, isError: false };
  }
}

export class ClaudeCli implements AgentCli {
  private readonly exec: CommandExecutor;

  constructor(private readonly options: ClaudeCliOptions) {
    this.exec = options.exec ?? runCommand;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const args = buildClaudeArgs(request, this.options);
    const startedAt = Date.now();

    const result = await this.exec(this.options.bin, args, {
      cwd: request.cwd,
      timeoutMs: request.timeoutMs
    });

    const durationMs = Date.now() - startedAt;

    if (result.timedOut) {
      throw new CommandError(
        `Claude Code supero el tiempo maximo (${Math.round(request.timeoutMs / 60000)} min).`,
        result
      );
    }

    const parsed = parseClaudeOutput(result.stdout);
    if (parsed.isError) {
      throw new CommandError(`Claude Code devolvio un error: ${tail(parsed.text || result.stderr)}`, result);
    }

    if (result.code !== 0 && !parsed.text) {
      throw new CommandError(
        `Claude Code termino con codigo ${result.code}: ${tail(result.stderr || result.stdout)}`,
        result
      );
    }

    const sessionId =
      parsed.sessionId ??
      request.sessionId ??
      (this.options.projectsDir
        ? findLatestClaudeSession(this.options.projectsDir, request.cwd, startedAt - 5_000)
        : undefined);

    return { text: parsed.text, sessionId, durationMs, exitCode: result.code };
  }
}
