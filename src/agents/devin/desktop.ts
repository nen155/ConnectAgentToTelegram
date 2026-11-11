import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand, stripAnsi } from '../../util/process';
import type { AgentDesktop, DesktopSendResult, DesktopWindow } from '../types';

export interface DevinDesktopOptions {
  /** Ruta a scripts/send-to-desktop.ps1 */
  scriptPath: string;
  tmpDir: string;
  /** Proyecto por defecto (carpeta de trabajo del agente). */
  projectName: string;
  /** Sufijo del titulo de la ventana (" - Devin"). */
  windowSuffix?: string;
  exec?: typeof runCommand;
}

/**
 * Escribe una orden en el compositor de la ventana de Devin Desktop de un proyecto.
 * La UI se manipula con UI Automation desde PowerShell (pegado sobre el control
 * 'Prompt'); si la ventana o el control no aparecen, devuelve el motivo y el llamador
 * decide si cae al CLI.
 */
export class DevinDesktop implements AgentDesktop {
  constructor(private readonly options: DevinDesktopOptions) {}

  private get windowSuffix(): string {
    return this.options.windowSuffix ?? ' - Devin';
  }

  private get exec(): typeof runCommand {
    return this.options.exec ?? runCommand;
  }

  /** Ventanas de Devin Desktop abiertas, con el proyecto que muestra cada una. */
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
          this.windowSuffix
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
          return {
            project: String(record.project ?? ''),
            title: String(record.title ?? '')
          };
        })
        .filter((window) => window.project.length > 0);
    } catch {
      return [];
    }
  }

  async send(prompt: string, project?: string): Promise<DesktopSendResult> {
    const target = project ?? this.options.projectName;
    const promptFile = path.join(this.options.tmpDir, `desktop-${randomUUID()}.txt`);
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
          this.windowSuffix
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
        .find(
          (line) =>
            line.startsWith('SIN_') ||
            line.startsWith('ERROR') ||
            line.startsWith('COMPOSITOR_OCUPADO') ||
            line.startsWith('SESION_OCUPADA')
        );

      return { sent: false, reason: reasonLine ?? 'la ventana no respondio', project: target };
    } catch (error) {
      return { sent: false, reason: (error as Error).message, project: target };
    } finally {
      await fs.rm(promptFile, { force: true }).catch(() => undefined);
    }
  }
}
