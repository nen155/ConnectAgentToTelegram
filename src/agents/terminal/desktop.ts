import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand, stripAnsi } from '../../util/process';
import type { AgentDesktop, CommandExecutor, DesktopSendResult, DesktopWindow } from '../types';

export interface TerminalDesktopOptions {
  /** Ruta a scripts/send-to-terminal.ps1 */
  scriptPath: string;
  tmpDir: string;
  /** Proyecto por defecto (carpeta de trabajo del agente). */
  projectName: string;
  /** Sufijo del titulo de la ventana del IDE (" - Devin"). */
  windowSuffix: string;
  /** Texto que debe identificar la terminal del agente ("opencode"). */
  expect: string;
  exec?: CommandExecutor;
}

const REASON_PREFIXES = ['SIN_', 'TERMINAL_', 'ERROR', 'COMPOSITOR_OCUPADO', 'SESION_OCUPADA'];

/**
 * Escribe la orden en la terminal integrada del IDE, donde viven las TUI de OpenCode,
 * Codex y Claude Code. Es opt-in: si el terminal no se identifica con `expect`, no se
 * escribe nada y el llamador cae al CLI.
 */
export class TerminalDesktop implements AgentDesktop {
  constructor(private readonly options: TerminalDesktopOptions) {}

  private get exec(): CommandExecutor {
    return this.options.exec ?? runCommand;
  }

  async listWindows(): Promise<DesktopWindow[]> {
    try {
      const result = await this.exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.options.scriptPath,
          '-ListWindows',
          '-WindowSuffix',
          this.options.windowSuffix
        ],
        { timeoutMs: 30_000 }
      );

      if (result.code !== 0) return [];

      const raw = stripAnsi(result.stdout).trim();
      if (!raw) return [];

      const parsed = JSON.parse(raw) as unknown;
      const items = Array.isArray(parsed) ? parsed : [parsed];

      return items
        .map((item) => {
          const record = item as Record<string, unknown>;
          return { project: String(record.project ?? ''), title: String(record.title ?? '') };
        })
        .filter((window) => window.project.length > 0);
    } catch {
      return [];
    }
  }

  async send(prompt: string, project?: string): Promise<DesktopSendResult> {
    const target = project ?? this.options.projectName;
    const promptFile = path.join(this.options.tmpDir, `terminal-${randomUUID()}.txt`);
    await fs.mkdir(this.options.tmpDir, { recursive: true });
    await fs.writeFile(promptFile, prompt, 'utf8');

    try {
      const result = await this.exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.options.scriptPath,
          '-Project',
          target,
          '-PromptFile',
          promptFile,
          '-WindowSuffix',
          this.options.windowSuffix,
          '-Expect',
          this.options.expect
        ],
        { timeoutMs: 60_000 }
      );

      const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
      if (result.code === 0 && output.includes('OK_ENVIADA')) {
        return { sent: true, project: target };
      }

      const reasonLine = output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => REASON_PREFIXES.some((prefix) => line.startsWith(prefix)));

      return { sent: false, reason: reasonLine ?? 'la terminal no respondio', project: target };
    } catch (error) {
      return { sent: false, reason: (error as Error).message, project: target };
    } finally {
      await fs.rm(promptFile, { force: true }).catch(() => undefined);
    }
  }
}
