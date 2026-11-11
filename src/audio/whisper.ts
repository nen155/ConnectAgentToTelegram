import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSuccess, runCommand, tail } from '../util/process';
import { toWhisperWav } from './ffmpeg';

export interface Transcriber {
  readonly name: string;
  transcribe(audioFile: string): Promise<string>;
}

export interface WhisperCppOptions {
  bin: string;
  model: string;
  language: string;
  threads: number;
  timeoutMs: number;
  ffmpegBin: string;
  tmpDir: string;
}

/**
 * Transcripcion 100% local con whisper.cpp (sin enviar el audio a ningun servicio).
 */
export class WhisperCppTranscriber implements Transcriber {
  readonly name = 'whisper.cpp';

  constructor(private readonly options: WhisperCppOptions) {}

  async transcribe(audioFile: string): Promise<string> {
    const base = path.join(this.options.tmpDir, `whisper-${randomUUID()}`);
    const wavFile = `${base}.wav`;
    const txtFile = `${base}.txt`;

    await toWhisperWav(this.options.ffmpegBin, audioFile, wavFile);

    try {
      const result = await runCommand(
        this.options.bin,
        [
          '-m',
          this.options.model,
          '-f',
          wavFile,
          '-l',
          this.options.language,
          '-t',
          String(this.options.threads),
          '-np',
          '-nt',
          '-otxt',
          '-of',
          base
        ],
        { timeoutMs: this.options.timeoutMs }
      );
      assertSuccess(result, 'Transcripcion con whisper.cpp');

      const transcript = await fs.readFile(txtFile, 'utf8');
      return normalizeTranscript(transcript);
    } finally {
      await Promise.allSettled([fs.rm(wavFile, { force: true }), fs.rm(txtFile, { force: true })]);
    }
  }
}

/** Limpia marcas de tiempo residuales y espacios repetidos. */
export function normalizeTranscript(raw: string): string {
  return raw
    .replace(/\[\s*\d{1,2}:\d{2}[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function whisperErrorHint(stderr: string): string | null {
  const output = stderr.toLowerCase();
  if (output.includes('failed to load model') || output.includes('failed to open')) {
    return 'Revisa que el modelo ggml exista (npm run setup:whisper) y que WHISPER_MODEL apunte al .bin correcto.';
  }
  if (output.includes('failed to read audio') || output.includes('invalid audio')) {
    return `El audio no se pudo leer: ${tail(stderr, 200)}`;
  }
  return null;
}
