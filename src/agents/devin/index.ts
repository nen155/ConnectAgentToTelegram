import { runCommand, stripAnsi } from '../../util/process';
import type { AppConfig } from '../../config';
import type { AgentAdapter, AgentCheck } from '../types';
import { DevinCli } from './cli';
import { DevinDesktop } from './desktop';
import { DevinSessions } from './sessions';
import { devinEnv } from './env';

async function checkDevin(bin: string): Promise<AgentCheck> {
  const problems: string[] = [];
  const notes: string[] = [];

  const version = await runCommand(bin, ['--version'], { timeoutMs: 20_000, env: devinEnv() }).catch(() => null);
  if (!version || version.code !== 0) {
    problems.push(
      `No encuentro el CLI de Devin ("${bin}"). Instalalo con: irm https://static.devin.ai/cli/setup.ps1 | iex`
    );
    return { ok: false, problems, notes };
  }
  notes.push(`Devin CLI: ${stripAnsi(version.stdout).trim().split('\n')[0]}`);

  const auth = await runCommand(bin, ['auth', 'status'], { timeoutMs: 20_000, env: devinEnv() }).catch(() => null);
  const output = `${auth?.stdout ?? ''}\n${auth?.stderr ?? ''}`;
  if (!auth || auth.code !== 0 || /not logged in/i.test(output)) {
    problems.push('Devin CLI no tiene sesion iniciada. Ejecuta `devin auth login` en esta PC.');
  }

  return { ok: problems.length === 0, problems, notes };
}

/** Adaptador de Devin: CLI `--print`, ventana de Devin Desktop y base de sesiones. */
export function createDevinAgent(config: AppConfig): AgentAdapter {
  const settings = config.agents.devin;

  return {
    name: 'devin',
    label: config.agent.label,
    cli: new DevinCli({
      bin: settings.bin,
      permissionMode: settings.permissionMode,
      model: settings.model,
      extraArgs: settings.extraArgs,
      tmpDir: config.paths.tmp
    }),
    sessions: new DevinSessions(settings.sessionsDb),
    desktop: new DevinDesktop({
      scriptPath: settings.scripts.desktop,
      tmpDir: config.paths.tmp,
      projectName: config.agent.projectName,
      windowSuffix: settings.windowSuffix
    }),
    check: () => checkDevin(settings.bin)
  };
}
