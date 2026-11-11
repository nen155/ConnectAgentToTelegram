import { assertSuccess, runCommand } from '../util/process';

/** Formatos que acepta whisper.cpp (WAV PCM 16 kHz mono). */
export async function toWhisperWav(ffmpegBin: string, input: string, output: string): Promise<void> {
  const result = await runCommand(
    ffmpegBin,
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output],
    { timeoutMs: 120_000 }
  );
  assertSuccess(result, 'Conversion de audio a WAV 16 kHz');
}

/** Nota de voz de Telegram: OGG/Opus mono. */
export async function toTelegramVoice(ffmpegBin: string, input: string, output: string): Promise<void> {
  const result = await runCommand(
    ffmpegBin,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      input,
      '-c:a',
      'libopus',
      '-b:a',
      '32k',
      '-ar',
      '48000',
      '-ac',
      '1',
      '-application',
      'voip',
      output
    ],
    { timeoutMs: 120_000 }
  );
  assertSuccess(result, 'Conversion de audio a nota de voz OGG/Opus');
}

export async function ffmpegVersion(ffmpegBin: string): Promise<string | null> {
  try {
    const result = await runCommand(ffmpegBin, ['-hide_banner', '-version'], { timeoutMs: 15_000 });
    if (result.code !== 0) return null;
    return result.stdout.split('\n')[0]?.trim() ?? 'ffmpeg';
  } catch {
    return null;
  }
}
