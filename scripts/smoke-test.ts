/**
 * Prueba de humo del pipeline de audio, sin Telegram de por medio:
 *   texto -> TTS (SAPI) -> OGG/Opus -> WAV -> whisper.cpp -> texto
 *
 * Uso: npm run smoke
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config';
import { WindowsSapiTts } from '../src/audio/tts';
import { WhisperCppTranscriber } from '../src/audio/whisper';
import { inspectReadiness, formatReadiness } from '../src/readiness';

const FRASE = 'Hola, esto es una prueba del puente de voz. Si me escuchas bien, la transcripcion se parecera a esta frase.';

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? 'smoke' });
  await fs.mkdir(config.paths.tmp, { recursive: true });

  const readiness = await inspectReadiness(config);
  console.log(formatReadiness(readiness) || '(sin notas)');
  console.log('');

  const tts = new WindowsSapiTts({
    scriptPath: config.paths.ttsScript,
    voice: config.tts.voice,
    rate: config.tts.rate,
    maxChars: config.tts.maxChars,
    ffmpegBin: config.ffmpegBin,
    tmpDir: config.paths.tmp
  });
  const transcriber = new WhisperCppTranscriber({
    bin: config.whisper.bin,
    model: config.whisper.model,
    language: config.whisper.language,
    threads: config.whisper.threads,
    timeoutMs: config.whisper.timeoutMs,
    ffmpegBin: config.ffmpegBin,
    tmpDir: config.paths.tmp
  });

  const oggFile = path.join(config.paths.tmp, `smoke-${randomUUID()}.ogg`);
  try {
    console.log('1/2 Sintetizando voz...');
    const startedTts = Date.now();
    await tts.synthesize(FRASE, oggFile);
    const stats = await fs.stat(oggFile);
    console.log(`    OK (${Math.round(stats.size / 1024)} KB, ${Date.now() - startedTts} ms)`);

    console.log('2/2 Transcribiendo con whisper.cpp...');
    const startedWhisper = Date.now();
    const transcript = await transcriber.transcribe(oggFile);
    console.log(`    OK (${Date.now() - startedWhisper} ms)`);

    console.log('');
    console.log(`Original   : ${FRASE}`);
    console.log(`Transcrito : ${transcript}`);
  } finally {
    await fs.rm(oggFile, { force: true });
  }
}

main().catch((error: unknown) => {
  console.error(`Fallo la prueba de humo: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
