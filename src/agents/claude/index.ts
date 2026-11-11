import { runCommand, stripAnsi } from '../../util/process';
import type { AppConfig } from '../../config';
import type { AgentAdapter, AgentCheck } from '../types';
import { TerminalDesktop } from '../terminal/desktop';
import { ClaudeCli } from './cli';
import { ClaudeSessions } from './sessions';

async function checkClaude(bin: string): Promise<AgentCheck> {
  const problems: string[] = [];
  const notes: string[] = [];

  const version = await runCommand(bin, ['--version'], { timeoutMs: 20_000 }).catch(() => null);
  if (!version || version.code !== 0) {
    problems.push(`No encuentro el CLI de Claude Code ("${bin}"). Instalalo con: npm i -g @anthropic-ai/claude-code`);
    return { ok: false, problems, notes };
  }
  notes.push(`Claude Code CLI: ${stripAnsi(version.stdout).trim().split('\n')[0]}`);

  return { ok: problems.length === 0, problems, notes };
}

/** Adaptador de Claude Code: `claude -p --output-format json`, transcripciones y terminal del IDE. */
export function createClaudeAgent(config: AppConfig): AgentAdapter {
  const settings = config.agents.claude;

  return {
    name: 'claude',
    label: config.agent.label,
    cli: new ClaudeCli({
      bin: settings.bin,
      model: settings.model,
      permissionMode: settings.permissionMode,
      extraArgs: settings.extraArgs,
      projectsDir: settings.projectsDir
    }),
    sessions: new ClaudeSessions(settings.projectsDir),
    desktop: new TerminalDesktop({
      scriptPath: settings.scripts.terminal,
      tmpDir: config.paths.tmp,
      projectName: config.agent.projectName,
      windowSuffix: settings.windowSuffix,
      expect: settings.terminalPattern
    }),
    check: () => checkClaude(settings.bin)
  };
}
