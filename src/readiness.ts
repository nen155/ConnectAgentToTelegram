import fs from 'node:fs';
import type { AppConfig } from './config';
import type { AgentAdapter } from './agents/types';
import { ffmpegVersion } from './audio/ffmpeg';

export interface Readiness {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/**
 * Comprueba las piezas externas (CLI del agente, whisper, ffmpeg, TTS) para poder
 * avisar por el propio chat en lugar de morir con un stack trace. La parte del agente
 * la aporta su adaptador (`check`), asi que aqui no hay nada especifico de Devin.
 */
export async function inspectReadiness(config: AppConfig, agent: AgentAdapter): Promise<Readiness> {
  const problems: string[] = [];
  const notes: string[] = [];

  if (config.mockMode) {
    notes.push('MOCK_MODE activo: transcripcion y respuestas simuladas');
    const ffmpegMock = await ffmpegVersion(config.ffmpegBin);
    if (ffmpegMock) notes.push(ffmpegMock);
    return { ok: problems.length === 0, problems, notes };
  }

  if (agent.check) {
    const check = await agent.check().catch((error: unknown) => ({
      ok: false,
      problems: [`No pude comprobar ${agent.label}: ${(error as Error).message}`],
      notes: []
    }));
    problems.push(...check.problems);
    notes.push(...check.notes);
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
