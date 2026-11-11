import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { CommandBridge, buildSummary, formatDuration, type Notifier } from '../src/core/bridge';
import { KeyedQueue } from '../src/core/taskQueue';
import { SessionStore } from '../src/devin/sessionStore';

function makeConfig(tmpDir: string): AppConfig {
  return {
    telegram: { token: 't', allowedUserIds: [1] },
    devin: {
      bin: 'devin',
      workdir: tmpDir,
      permissionMode: 'dangerous',
      timeoutMs: 1000,
      continuity: 'auto',
      extraArgs: [],
      sessionsDb: path.join(tmpDir, 'sessions.db')
    },
    whisper: { bin: 'w', model: 'm', language: 'es', threads: 1, timeoutMs: 1000 },
    tts: { enabled: true, rate: 0, maxChars: 500 },
    ffmpegBin: 'ffmpeg',
    paths: {
      data: tmpDir,
      tmp: tmpDir,
      sessionsFile: path.join(tmpDir, 'sessions.json'),
      logFile: path.join(tmpDir, 'bridge.log'),
      ttsScript: 'script.ps1',
      statusFile: path.join(tmpDir, 'status.json')
    },
    logLevel: 'error',
    mockMode: false
  };
}

function makeNotifier(): Notifier & { texts: string[]; voices: string[] } {
  const texts: string[] = [];
  const voices: string[] = [];
  return {
    texts,
    voices,
    text: async (message) => {
      texts.push(message);
    },
    voice: async (filePath) => {
      voices.push(filePath);
    }
  };
}

async function setup(
  overrides: { run?: jest.Mock; synthesize?: jest.Mock; transcribe?: jest.Mock } = {}
) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-'));
  const config = makeConfig(tmpDir);
  const store = new SessionStore(config.paths.sessionsFile);
  await store.load();

  const run = overrides.run ?? jest.fn(async () => ({ text: 'arregle el bug', sessionId: 'brisk-otter', durationMs: 65_000, exitCode: 0 }));
  const synthesize = overrides.synthesize ?? jest.fn(async (_text: string, out: string) => {
    await fs.writeFile(out, 'audio');
  });
  const transcribe = overrides.transcribe ?? jest.fn(async () => 'arregla el bug del login');
  const publish = jest.fn(async (_state: string, _extra?: unknown) => undefined);

  const bridge = new CommandBridge({
    runner: { run },
    transcriber: { name: 'fake', transcribe },
    tts: { synthesize },
    store,
    queue: new KeyedQueue(),
    config,
    logger: createLogger({ level: 'error' }),
    status: { publish }
  });

  return { bridge, config, store, run, synthesize, transcribe, publish, tmpDir };
}

describe('CommandBridge', () => {
  it('ejecuta la orden, guarda la sesion y responde con texto y voz', async () => {
    const { bridge, store, run, synthesize } = await setup();
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'arregla el bug', notifier);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'arregla el bug', cwd: expect.any(String) }));
    expect(notifier.texts.some((text) => text.includes('arregle el bug'))).toBe(true);
    expect(notifier.voices).toHaveLength(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(store.get('42')).toMatchObject({ sessionId: 'brisk-otter', runs: 1 });
  });

  it('reanuda la sesion guardada en la siguiente orden', async () => {
    const { bridge, run } = await setup();
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'primera', notifier);
    await bridge.handlePrompt('42', 'segunda', notifier);

    expect(run).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'brisk-otter' }));
  });

  it('responde con el error sin romper el proceso', async () => {
    const run = jest.fn(async () => {
      throw new Error('Devin CLI no tiene sesion iniciada');
    });
    const { bridge } = await setup({ run });
    const notifier = makeNotifier();

    await expect(bridge.handlePrompt('42', 'hola', notifier)).resolves.toBeUndefined();
    expect(notifier.texts.at(-1)).toContain('❌');
    expect(notifier.texts.at(-1)).toContain('sesion iniciada');
  });

  it('no pierde la respuesta de texto si el TTS falla', async () => {
    const synthesize = jest.fn(async () => {
      throw new Error('SAPI no disponible');
    });
    const { bridge } = await setup({ synthesize });
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'hola', notifier);

    expect(notifier.texts.some((text) => text.includes('arregle el bug'))).toBe(true);
    expect(notifier.voices).toHaveLength(0);
  });

  it('transcribe el audio y muestra lo que entendio', async () => {
    const { bridge, transcribe } = await setup();
    const notifier = makeNotifier();

    await bridge.handleVoice('42', 'audio.ogg', notifier);

    expect(transcribe).toHaveBeenCalledWith('audio.ogg');
    expect(notifier.texts.join(' ')).toContain('arregla el bug del login');
  });

  it('acusa recibo del audio antes de transcribir', async () => {
    let ackBeforeTranscribe = false;
    const notifier = makeNotifier();
    const transcribe = jest.fn(async () => {
      ackBeforeTranscribe = notifier.texts.some((text) => text.includes('Audio recibido'));
      return 'hola';
    });
    const { bridge } = await setup({ transcribe });

    await bridge.handleVoice('42', 'audio.ogg', notifier);

    expect(ackBeforeTranscribe).toBe(true);
  });

  it('publica el estado para la bandeja: transcribiendo, trabajando, respondiendo, inactivo', async () => {
    const { bridge, publish } = await setup();
    const notifier = makeNotifier();

    await bridge.handleVoice('42', 'audio.ogg', notifier);

    const states = publish.mock.calls.map((call) => call[0]);
    expect(states).toEqual(['transcribing', 'working', 'replying', 'idle']);
    expect(publish).toHaveBeenCalledWith(
      'working',
      expect.objectContaining({ current: expect.objectContaining({ prompt: 'arregla el bug del login' }) })
    );
  });

  it('deja la orden en el historial con su duracion y estado', async () => {
    const { bridge, publish } = await setup();
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'arregla el bug', notifier);

    const lastCall = publish.mock.calls.at(-1);
    const snapshot = lastCall?.[1] as { recent: Array<Record<string, unknown>> };
    expect(snapshot.recent[0]).toMatchObject({ prompt: 'arregla el bug', state: 'done', exitCode: 0 });
    expect(snapshot.recent[0]?.durationMs).toBe(65_000);
  });

  it('registra el error en el historial cuando la orden falla', async () => {
    const run = jest.fn(async () => {
      throw new Error('fallo simulado');
    });
    const { bridge, publish } = await setup({ run });
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'hola', notifier);

    const snapshot = publish.mock.calls.at(-1)?.[1] as { recent: Array<Record<string, unknown>> };
    expect(snapshot.recent[0]).toMatchObject({ state: 'error', error: 'fallo simulado' });
  });

  it('deja el estado inactivo aunque la orden falle', async () => {
    const run = jest.fn(async () => {
      throw new Error('fallo simulado');
    });
    const { bridge, publish } = await setup({ run });
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'hola', notifier);

    expect(publish.mock.calls.map((call) => call[0])).toEqual(['working', 'idle']);
  });

  it('avisa cuando el audio no tiene voz reconocible', async () => {
    const { bridge } = await setup({ transcribe: jest.fn(async () => '   ') });
    const notifier = makeNotifier();

    await bridge.handleVoice('42', 'silencio.ogg', notifier);
    expect(notifier.texts.join(' ')).toContain('No entendi nada');
  });
});

describe('buildSummary', () => {
  it('incluye la duracion legible', () => {
    expect(buildSummary('hecho', 65_000)).toContain('1m 5s');
    expect(buildSummary('hecho', 5_000)).toContain('5s');
  });

  it('avisa de que Devin no devolvio texto', () => {
    expect(buildSummary('   ', 1_000)).toContain('no produje texto');
  });

  it('indica que espera nuevas ordenes cuando no queda cola', () => {
    expect(buildSummary('hecho', 1_000, 0)).toContain('Esperando nuevas ordenes');
  });

  it('indica cuantas ordenes quedan en cola', () => {
    expect(buildSummary('hecho', 1_000, 2)).toContain('Quedan 2 orden(es) en cola');
  });
});

describe('formatDuration', () => {
  it('formatea minutos exactos sin segundos', () => {
    expect(formatDuration(120_000)).toBe('2m');
  });
});
