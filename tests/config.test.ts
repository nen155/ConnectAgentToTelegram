import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from '../src/config';

const baseEnv = { TELEGRAM_BOT_TOKEN: 'token-de-prueba' } as NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('normaliza la allowlist de usuarios', () => {
    const config = loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: ' 111 , 222,333 ' });
    expect(config.telegram.allowedUserIds).toEqual([111, 222, 333]);
  });

  it('rechaza ids no numericos en la allowlist', () => {
    expect(() => loadConfig({ ...baseEnv, TELEGRAM_ALLOWED_USER_IDS: '111,ana' })).toThrow(/IDs numericos/);
  });

  it('exige el token del bot', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow();
  });

  it('explica el error de configuracion en lenguaje legible', () => {
    expect(() => loadConfig({} as NodeJS.ProcessEnv)).toThrow(/Configuracion invalida:\n- TELEGRAM_BOT_TOKEN:/);
  });

  it('mapea los alias yolo/bypass a dangerous', () => {
    expect(loadConfig({ ...baseEnv, DEVIN_PERMISSION_MODE: 'yolo' }).devin.permissionMode).toBe('dangerous');
    expect(loadConfig({ ...baseEnv, DEVIN_PERMISSION_MODE: 'bypass' }).devin.permissionMode).toBe('dangerous');
  });

  it('interpreta TTS_ENABLED de forma tolerante', () => {
    expect(loadConfig({ ...baseEnv, TTS_ENABLED: 'false' }).tts.enabled).toBe(false);
    expect(loadConfig({ ...baseEnv, TTS_ENABLED: 'no' }).tts.enabled).toBe(false);
    expect(loadConfig({ ...baseEnv, TTS_ENABLED: 'si' }).tts.enabled).toBe(true);
    expect(loadConfig(baseEnv).tts.enabled).toBe(true);
  });

  it('activa el modo mock solo cuando se pide', () => {
    expect(loadConfig(baseEnv).mockMode).toBe(false);
    expect(loadConfig({ ...baseEnv, MOCK_MODE: 'true' }).mockMode).toBe(true);
    expect(loadConfig({ ...baseEnv, MOCK_MODE: 'false' }).mockMode).toBe(false);
  });

  it('usa rutas por defecto dentro del proyecto', () => {
    const config = loadConfig(baseEnv);
    expect(config.devin.workdir).toBe(PROJECT_ROOT);
    expect(config.whisper.bin).toBe(path.join(PROJECT_ROOT, 'vendor', 'whisper', 'whisper-cli.exe'));
    expect(config.whisper.model).toBe(path.join(PROJECT_ROOT, 'vendor', 'models', 'ggml-small.bin'));
    expect(config.paths.sessionsFile).toBe(path.join(PROJECT_ROOT, 'data', 'sessions.json'));
  });

  it('respeta DEVIN_WORKDIR y DEVIN_EXTRA_ARGS', () => {
    const config = loadConfig({
      ...baseEnv,
      DEVIN_WORKDIR: path.join(PROJECT_ROOT, 'sub'),
      DEVIN_EXTRA_ARGS: '--model opus  --verbose'
    });
    expect(config.devin.workdir).toBe(path.join(PROJECT_ROOT, 'sub'));
    expect(config.devin.extraArgs).toEqual(['--model', 'opus', '--verbose']);
  });
});
