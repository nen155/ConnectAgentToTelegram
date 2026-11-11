import fs from 'node:fs';
import type { AppConfig } from './config';
import { ffmpegVersion } from './audio/ffmpeg';
import { runCommand, stripAnsi } from './util/process';
import { devinEnv } from './devin/env';

export interface Readiness {
  ok: boolean;
  problems: string[];
  notes: string[];
}

async function tryRun(bin: string, args: string[]): Promise<string | null> {
  try {
    const result = await runCommand(bin, args, { timeoutMs: 20_000, env: devinEnv() });
    if (result.code !== 0) return null;
    return stripAnsi(result.stdout).trim();
  } catch {
    return null;
  }
}

/**
 * Comprueba las piezas externas (Devin CLI, whisper, ffmpeg, TTS) para poder
 * avisar por el propio chat en lugar de morir con un stack trace.
 */
export async function inspectReadiness(config: AppConfig): Promise<Readiness> {
  const problems: string[] = [];
  const notes: string[] = [];

  if (config.mockMode) {
    notes.push('MOCK_MODE activo: transcripcion y respuestas simuladas');
    const ffmpegMock = await ffmpegVersion(config.ffmpegBin);
    if (ffmpegMock) notes.push(ffmpegMock);
    return { ok: problems.length === 0, problems, notes };
  }

  const devinVersion = await tryRun(config.devin.bin, ['--version']);
  if (!devinVersion) {
    problems.push(
      `No encuentro el CLI de Devin ("${config.devin.bin}"). Instalalo con: irm https://static.devin.ai/cli/setup.ps1 | iex`
    );
  } else {
    notes.push(`Devin CLI: ${devinVersion.split('\n')[0]}`);
    const auth = await tryRun(config.devin.bin, ['auth', 'status']);
    if (!auth || /not logged in/i.test(auth)) {
      problems.push('Devin CLI no tiene sesion iniciada. Ejecuta `devin auth login` en esta PC.');
    }
  }

  if (!fs.existsSync(config.whisper.bin)) {
    problems.push(`Falta whisper.cpp en "${config.whisper.bin}". Ejecuta: npm run setup:whisper`);
  }
  if (!fs.existsSync(config.whisper.model)) {
    problems.push(`Falta el modelo de whisper en "${config.whisper.model}". Ejecuta: npm run setup:whisper`);
  }

  const ffmpeg = await ffmpegVersion(config.ffmpegBin);
  if (!ffmpeg) {
    problems.push(`No encuentro ffmpeg ("${config.ffmpegBin}"). Anadelo al PATH o define FFMPEG_BIN.`);
  } else {
    notes.push(ffmpeg);
  }

  if (config.tts.enabled && !fs.existsSync(config.paths.ttsScript)) {
    problems.push(`Falta el script de voz "${config.paths.ttsScript}".`);
  }

  return { ok: problems.length === 0, problems, notes };
}

export function formatReadiness(readiness: Readiness): string {
  const lines: string[] = [];
  if (readiness.notes.length > 0) lines.push(...readiness.notes.map((note) => `- ${note}`));
  if (readiness.problems.length > 0) {
    lines.push('', 'Pendiente:');
    lines.push(...readiness.problems.map((problem) => `- ${problem}`));
  }
  return lines.join('\n');
}
