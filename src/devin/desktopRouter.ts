import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runCommand, stripAnsi } from '../util/process';

export interface DesktopSendResult {
  sent: boolean;
  reason?: string;
}

export interface DesktopRouterOptions {
  /** Ruta a scripts/send-to-desktop.ps1 */
  scriptPath: string;
  tmpDir: string;
  /** Nombre que aparece al principio del titulo de la ventana (carpeta del proyecto). */
  projectName: string;
  exec?: typeof runCommand;
}

/**
 * Escribe una orden en el compositor de la ventana de Devin Desktop del proyecto.
 * La UI se manipula con UI Automation desde PowerShell (ValuePattern sobre el control
 * 'Prompt'); si la ventana o el control no aparecen, devuelve el motivo y el llamador
 * decide si cae al CLI.
 */
export class DesktopRouter {
  constructor(private readonly options: DesktopRouterOptions) {}

  async send(prompt: string): Promise<DesktopSendResult> {
    const promptFile = path.join(this.options.tmpDir, `desktop-${randomUUID()}.txt`);
    await fs.mkdir(this.options.tmpDir, { recursive: true });
    await fs.writeFile(promptFile, prompt, 'utf8');

    try {
      const exec = this.options.exec ?? runCommand;
      const result = await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.options.scriptPath,
          '-Project',
          this.options.projectName,
          '-PromptFile',
          promptFile
        ],
        { timeoutMs: 60_000 }
      );

      const output = stripAnsi(`${result.stdout}\n${result.stderr}`).trim();
      if (result.code === 0 && output.includes('OK_ENVIADA')) {
        return { sent: true };
      }

      const reasonLine = output
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.startsWith('SIN_') || line.startsWith('ERROR'));

      return { sent: false, reason: reasonLine ?? 'la ventana no respondio' };
    } catch (error) {
      return { sent: false, reason: (error as Error).message };
    } finally {
      await fs.rm(promptFile, { force: true }).catch(() => undefined);
    }
  }
}
