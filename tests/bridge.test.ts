import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { CommandBridge, buildSummary, formatDuration, withLanguageInstruction, type Notifier } from '../src/core/bridge';
import { KeyedQueue } from '../src/core/taskQueue';
import { SessionStore } from '../src/core/sessionStore';

function makeConfig(tmpDir: string): AppConfig {
  return {
    telegram: { token: 't', allowedUserIds: [1] },
    agent: {
      name: 'devin',
      label: 'Devin',
      workdir: tmpDir,
      projectName: 'mi-proyecto',
      timeoutMs: 1000,
      continuity: 'auto',
      route: 'auto'
    },
    agents: {
      devin: {
        bin: 'devin',
        permissionMode: 'dangerous',
        extraArgs: [],
        sessionsDb: path.join(tmpDir, 'sessions.db'),
        windowSuffix: ' - Devin',
        scripts: { desktop: 'desktop.ps1', terminal: 'terminal.ps1' }
      },
      opencode: {
        bin: 'opencode',
        skipPermissions: true,
        extraArgs: [],
        sessionsDb: path.join(tmpDir, 'opencode.db'),
        windowSuffix: ' - Devin',
        terminalPattern: 'opencode',
        scripts: { desktop: 'desktop.ps1', terminal: 'terminal.ps1' }
      },
      codex: {
        bin: 'codex',
        fullAuto: true,
        skipGitRepoCheck: true,
        extraArgs: [],
        sessionsDir: path.join(tmpDir, 'codex'),
        windowSuffix: ' - Devin',
        terminalPattern: 'codex',
        scripts: { desktop: 'desktop.ps1', terminal: 'terminal.ps1' }
      },
      claude: {
        bin: 'claude',
        permissionMode: 'bypassPermissions',
        extraArgs: [],
        projectsDir: path.join(tmpDir, 'claude'),
        windowSuffix: ' - Devin',
        terminalPattern: 'claude',
        scripts: { desktop: 'desktop.ps1', terminal: 'terminal.ps1' }
      },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
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
      statusFile: path.join(tmpDir, 'status.json'),
      replyRoutesFile: path.join(tmpDir, 'reply-routes.json'),
      sendToDesktopScript: 'desktop.ps1',
      sendToTerminalScript: 'terminal.ps1'
    },
    logLevel: 'error',
    summaryLanguage: '',
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
  overrides: {
    run?: jest.Mock;
    synthesize?: jest.Mock;
    transcribe?: jest.Mock;
    resolveIdeSession?: () => Promise<{ id: string; title: string; busy: boolean } | null>;
    desktop?: {
      send: (prompt: string, project?: string) => Promise<{ sent: boolean; reason?: string; project?: string }>;
      listWindows: () => Promise<Array<{ project: string; title: string }>>;
    };
    knownProjects?: () => Promise<string[]>;
  } = {}
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
    status: { publish },
    ...(overrides.resolveIdeSession ? { resolveIdeSession: overrides.resolveIdeSession } : {}),
    ...(overrides.desktop ? { desktop: overrides.desktop } : {}),
    ...(overrides.knownProjects ? { knownProjects: overrides.knownProjects } : {})
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

  it('reanuda la sesion del IDE cuando el proyecto esta abierto alli', async () => {
    const { bridge, run } = await setup({
      resolveIdeSession: async () => ({ id: 'visual-hacksaw', title: 'Pasar contenido a la web', busy: false })
    });
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'sigue con eso', notifier);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'visual-hacksaw' }));
    expect(notifier.texts.join(' ')).toContain('Continuando la sesion del IDE');
  });

  it('no invade la sesion del IDE si esta trabajando', async () => {
    const { bridge, run } = await setup({
      resolveIdeSession: async () => ({ id: 'visual-hacksaw', title: 'Pasar contenido a la web', busy: true })
    });
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'sigue con eso', notifier);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: undefined }));
    expect(notifier.texts.join(' ')).toContain('esta trabajando');
  });

  it('no consulta al IDE si el enrutado esta en modo chat', async () => {
    const resolveIdeSession = jest.fn(async () => ({ id: 'x', title: 'x', busy: false }));
    const { bridge, config } = await setup({ resolveIdeSession });
    config.agent.route = 'chat';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'hola', notifier);

    expect(resolveIdeSession).not.toHaveBeenCalled();
  });

  it('envia la orden a la ventana del IDE sin lanzar el CLI en modo desktop', async () => {
    const desktop = {
      send: jest.fn(async () => ({ sent: true })),
      listWindows: jest.fn(async () => [{ project: 'mi-proyecto', title: 'mi-proyecto - Devin' }])
    };
    const { bridge, run, config } = await setup({ desktop });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'arregla el login', notifier);

    expect(desktop.send).toHaveBeenCalledWith('arregla el login', 'mi-proyecto');
    expect(run).not.toHaveBeenCalled();
    expect(notifier.texts.join(' ')).toContain('Orden enviada a Devin');
  });

  it('enruta al proyecto que se nombra en la orden', async () => {
    const desktop = {
      send: jest.fn(async () => ({ sent: true })),
      listWindows: jest.fn(async () => [
        { project: 'mi-proyecto', title: 'mi-proyecto - Devin' },
        { project: 'Silver Utilizar Silver CD 2 ISO', title: 'Silver Utilizar Silver CD 2 ISO - Devin' }
      ])
    };
    const { bridge, config } = await setup({ desktop });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'en Silver, continua con lo pendiente', notifier);

    expect(desktop.send).toHaveBeenCalledWith('en Silver, continua con lo pendiente', 'Silver Utilizar Silver CD 2 ISO');
    expect(notifier.texts.join(' ')).toContain('Silver Utilizar Silver CD 2 ISO');
  });

  it('avisa si el proyecto nombrado no tiene ventana abierta', async () => {
    const desktop = {
      send: jest.fn(async () => ({ sent: true })),
      listWindows: jest.fn(async () => [{ project: 'mi-proyecto', title: 'mi-proyecto - Devin' }])
    };
    const { bridge, run, config } = await setup({
      desktop,
      knownProjects: async () => ['Silver Utilizar Silver CD 2 ISO', 'mi-proyecto']
    });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'en Silver continua', notifier);

    expect(desktop.send).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
    expect(notifier.texts.join(' ')).toContain('no esta abierta');
  });

  it('cae al CLI si no puede escribir en la ventana del IDE', async () => {
    const desktop = {
      send: jest.fn(async () => ({ sent: false, reason: 'COMPOSITOR_OCUPADO' })),
      listWindows: jest.fn(async () => [{ project: 'mi-proyecto', title: 'mi-proyecto - Devin' }])
    };
    const { bridge, run, config } = await setup({ desktop });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'arregla el login', notifier);

    expect(run).toHaveBeenCalled();
    expect(notifier.texts.join(' ')).toContain('No pude escribir en Devin');
  });

  it('no encola en la ventana si la sesion del IDE esta trabajando', async () => {
    const desktop = {
      send: jest.fn(async () => ({
        sent: false,
        reason: 'SESION_OCUPADA: la sesion del IDE esta trabajando; no se escribe nada'
      })),
      listWindows: jest.fn(async () => [{ project: 'mi-proyecto', title: 'mi-proyecto - Devin' }])
    };
    const { bridge, run, config } = await setup({ desktop });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'arregla el login', notifier);

    expect(run).toHaveBeenCalled();
    expect(notifier.texts.join(' ')).toContain('y no la pongo en cola');
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

  it('resume la salida larga conservando el final', () => {
    const text = `${'paso intermedio. '.repeat(200)}\n\nConclusion: migracion terminada y tests en verde.`;
    const summary = buildSummary(text, 1_000);

    expect(summary).toContain('Conclusion: migracion terminada');
    expect(summary).toContain('\n…\n');
    expect(summary).not.toContain('paso intermedio. '.repeat(200));
  });
});

describe('formatDuration', () => {
  it('formatea minutos exactos sin segundos', () => {
    expect(formatDuration(120_000)).toBe('2m');
  });
});

describe('withLanguageInstruction', () => {
  it('anade la instruccion de idioma al final de la orden', () => {
    const result = withLanguageInstruction('arregla el login', 'es');
    expect(result).toContain('arregla el login');
    expect(result).toContain('español');
  });

  it('no toca la orden si no se fuerza idioma', () => {
    expect(withLanguageInstruction('arregla el login', '')).toBe('arregla el login');
  });
});

describe('prioridad de enrutado', () => {
  it('la respuesta a un mensaje manda sobre el proyecto mencionado en el texto', async () => {
    const desktop = {
      send: jest.fn(async () => ({ sent: true })),
      listWindows: jest.fn(async () => [
        { project: 'Silver Utilizar Silver CD 2 ISO', title: 'a' },
        { project: 'MilioLab', title: 'b' }
      ])
    };
    const { bridge, config } = await setup({ desktop });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'en Silver continua', notifier, { project: 'MilioLab' });

    expect(desktop.send).toHaveBeenCalledWith(expect.any(String), 'MilioLab');
  });

  it('sin respuesta, sigue infiriendo el proyecto del texto', async () => {
    const desktop = {
      send: jest.fn(async () => ({ sent: true })),
      listWindows: jest.fn(async () => [{ project: 'Silver Utilizar Silver CD 2 ISO', title: 'a' }])
    };
    const { bridge, config } = await setup({ desktop });
    config.agent.route = 'desktop';
    const notifier = makeNotifier();

    await bridge.handlePrompt('42', 'en Silver continua', notifier);

    expect(desktop.send).toHaveBeenCalledWith(expect.any(String), 'Silver Utilizar Silver CD 2 ISO');
  });
});
