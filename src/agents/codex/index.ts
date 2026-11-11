import { runCommand, stripAnsi } from '../../util/process';
import type { AppConfig } from '../../config';
import type { AgentAdapter, AgentCheck } from '../types';
import { TerminalDesktop } from '../terminal/desktop';
import { CodexCli } from './cli';
import { CodexSessions } from './sessions';

async function checkCodex(bin: string): Promise<AgentCheck> {
  const problems: string[] = [];
  const notes: string[] = [];

  const version = await runCommand(bin, ['--version'], { timeoutMs: 20_000 }).catch(() => null);
  if (!version || version.code !== 0) {
    problems.push(`No encuentro el CLI de Codex ("${bin}"). Instalalo con: npm i -g @openai/codex`);
    return { ok: false, problems, notes };
  }
  notes.push(`Codex CLI: ${stripAnsi(version.stdout).trim().split('\n')[0]}`);

  return { ok: problems.length === 0, problems, notes };
}

/** Adaptador de Codex (OpenAI CLI): `codex exec`, rollouts en disco y terminal del IDE. */
export function createCodexAgent(config: AppConfig): AgentAdapter {
  const settings = config.agents.codex;

  return {
    name: 'codex',
    label: config.agent.label,
    cli: new CodexCli({
      bin: settings.bin,
      model: settings.model,
      fullAuto: settings.fullAuto,
      skipGitRepoCheck: settings.skipGitRepoCheck,
      extraArgs: settings.extraArgs,
      sessionsDir: settings.sessionsDir
    }),
    sessions: new CodexSessions(settings.sessionsDir),
    desktop: new TerminalDesktop({
      scriptPath: settings.scripts.terminal,
      tmpDir: config.paths.tmp,
      projectName: config.agent.projectName,
      windowSuffix: settings.windowSuffix,
      expect: settings.terminalPattern
    }),
    check: () => checkCodex(settings.bin)
  };
}
