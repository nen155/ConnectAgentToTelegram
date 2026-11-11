import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSuccess, runCommand } from '../util/process';
import { toTelegramVoice } from './ffmpeg';

export interface TextToSpeech {
  readonly name: string;
  synthesize(text: string, outputOgg: string): Promise<void>;
}

export interface SapiTtsOptions {
  scriptPath: string;
  voice?: string;
  rate: number;
  maxChars: number;
  ffmpegBin: string;
  tmpDir: string;
}

/**
 * TTS offline con las voces instaladas en Windows (System.Speech / SAPI).
 * El texto viaja por archivo, nunca interpolado en la linea de comandos.
 */
export class WindowsSapiTts implements TextToSpeech {
  readonly name = 'windows-sapi';

  constructor(private readonly options: SapiTtsOptions) {}

  async synthesize(text: string, outputOgg: string): Promise<void> {
    const spoken = clipForSpeech(text, this.options.maxChars);
    if (!spoken) throw new Error('No hay texto que sintetizar');

    const id = randomUUID();
    const textFile = path.join(this.options.tmpDir, `tts-${id}.txt`);
    const wavFile = path.join(this.options.tmpDir, `tts-${id}.wav`);

    await fs.writeFile(textFile, spoken, 'utf8');

    try {
      const args = [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        this.options.scriptPath,
        '-TextFile',
        textFile,
        '-OutFile',
        wavFile,
        '-Rate',
        String(this.options.rate)
      ];
      if (this.options.voice) args.push('-Voice', this.options.voice);

      const result = await runCommand('powershell.exe', args, { timeoutMs: 120_000 });
      assertSuccess(result, 'Sintesis de voz (SAPI)');

      await toTelegramVoice(this.options.ffmpegBin, wavFile, outputOgg);
    } finally {
      await Promise.allSettled([fs.rm(textFile, { force: true }), fs.rm(wavFile, { force: true })]);
    }
  }
}

/** Deja el texto legible en voz alta: sin markdown, emojis ni bloques de codigo. */
export function clipForSpeech(text: string, maxChars: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' (bloque de codigo omitido) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>|]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return `${(lastStop > maxChars * 0.5 ? cut.slice(0, lastStop) : cut).trim()} ...`;
}
