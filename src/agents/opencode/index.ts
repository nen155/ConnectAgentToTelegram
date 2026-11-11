import fs from 'node:fs';
import path from 'node:path';
import { runCommand, stripAnsi } from '../../util/process';
import type { AppConfig } from '../../config';
import type { AgentAdapter, AgentCheck } from '../types';
import { TerminalDesktop } from '../terminal/desktop';
import { OpenCodeCli } from './cli';
import { OpenCodeSessions } from './sessions';

async function checkOpenCode(bin: string, sessionsDb: string): Promise<AgentCheck> {
  const problems: string[] = [];
  const notes: string[] = [];

  const version = await runCommand(bin, ['--version'], { timeoutMs: 20_000 }).catch(() => null);
  if (!version || version.code !== 0) {
    problems.push(`No encuentro el CLI de OpenCode ("${bin}"). Instalalo con: npm i -g opencode-ai`);
    return { ok: false, problems, notes };
  }
  notes.push(`OpenCode CLI: ${stripAnsi(version.stdout).trim().split('\n')[0]}`);

  // OpenCode guarda las credenciales en auth.json; sin ellas algunos proveedores
  // gratuitos siguen funcionando, asi que se avisa como nota y no como problema.
  const authFile = path.join(path.dirname(sessionsDb), 'auth.json');
  let credentials = 0;
  try {
    const raw = JSON.parse(fs.readFileSync(authFile, 'utf8')) as Record<string, unknown>;
    credentials = Object.keys(raw).length;
  } catch {
    credentials = 0;
  }
  if (credentials === 0) {
    notes.push(`OpenCode no tiene credenciales en ${authFile}; ejecuta \`opencode auth login\` si el modelo falla.`);
  }

  return { ok: problems.length === 0, problems, notes };
}

/**
 * Adaptador de OpenCode: `opencode run` para ejecutar, su base SQLite para observar
 * sesiones y la terminal del IDE para escribir en la TUI.
 */
export function createOpenCodeAgent(config: AppConfig): AgentAdapter {
  const settings = config.agents.opencode;

  return {
    name: 'opencode',
    label: config.agent.label,
    cli: new OpenCodeCli({
      bin: settings.bin,
      model: settings.model,
      agent: settings.agent,
      skipPermissions: settings.skipPermissions,
      extraArgs: settings.extraArgs,
      sessionsDb: settings.sessionsDb
    }),
    sessions: new OpenCodeSessions(settings.sessionsDb),
    desktop: new TerminalDesktop({
      scriptPath: settings.scripts.terminal,
      tmpDir: config.paths.tmp,
      projectName: config.agent.projectName,
      windowSuffix: settings.windowSuffix,
      expect: settings.terminalPattern
    }),
    check: () => checkOpenCode(settings.bin, settings.sessionsDb)
  };
}
