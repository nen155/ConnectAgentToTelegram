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
    expect(loadConfig({ ...baseEnv, DEVIN_PERMISSION_MODE: 'yolo' }).agents.devin.permissionMode).toBe('dangerous');
    expect(loadConfig({ ...baseEnv, DEVIN_PERMISSION_MODE: 'bypass' }).agents.devin.permissionMode).toBe('dangerous');
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
    expect(config.agent.workdir).toBe(PROJECT_ROOT);
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
    expect(config.agent.workdir).toBe(path.join(PROJECT_ROOT, 'sub'));
    expect(config.agents.devin.extraArgs).toEqual(['--model', 'opus', '--verbose']);
  });

  it('elige Devin por defecto y otro agente con AGENT', () => {
    expect(loadConfig(baseEnv).agent.name).toBe('devin');
    expect(loadConfig(baseEnv).agent.label).toBe('Devin');

    const opencode = loadConfig({ ...baseEnv, AGENT: 'opencode' });
    expect(opencode.agent.name).toBe('opencode');
    expect(opencode.agent.label).toBe('OpenCode');
    expect(opencode.agents.opencode.bin).toBe('opencode');
  });

  it('los nombres genericos mandan sobre los historicos DEVIN_*', () => {
    const config = loadConfig({
      ...baseEnv,
      DEVIN_WORKDIR: path.join(PROJECT_ROOT, 'viejo'),
      AGENT_WORKDIR: path.join(PROJECT_ROOT, 'nuevo'),
      DEVIN_ROUTE: 'chat',
      AGENT_ROUTE: 'desktop',
      DEVIN_TIMEOUT_MS: '1000',
      AGENT_TIMEOUT_MS: '2000'
    });
    expect(config.agent.workdir).toBe(path.join(PROJECT_ROOT, 'nuevo'));
    expect(config.agent.route).toBe('desktop');
    expect(config.agent.timeoutMs).toBe(2000);
  });

  it('sin AGENT_* sigue aceptando DEVIN_ROUTE y DEVIN_CONTINUITY', () => {
    const config = loadConfig({ ...baseEnv, DEVIN_ROUTE: 'desktop', DEVIN_CONTINUITY: 'new' });
    expect(config.agent.route).toBe('desktop');
    expect(config.agent.continuity).toBe('new');
  });

  it('cada agente lee su propio bloque de configuracion', () => {
    const config = loadConfig({
      ...baseEnv,
      AGENT: 'claude',
      OPENCODE_MODEL: 'opencode/big-pickle',
      OPENCODE_SKIP_PERMISSIONS: 'false',
      CODEX_MODEL: 'gpt-5-codex',
      CLAUDE_MODEL: 'claude-sonnet-4-6',
      CLAUDE_PERMISSION_MODE: 'acceptEdits',
      OPENAI_MODEL: 'gpt-4o-mini'
    });

    expect(config.agents.opencode.model).toBe('opencode/big-pickle');
    expect(config.agents.opencode.skipPermissions).toBe(false);
    expect(config.agents.codex.model).toBe('gpt-5-codex');
    expect(config.agents.claude.model).toBe('claude-sonnet-4-6');
    expect(config.agents.claude.permissionMode).toBe('acceptEdits');
    expect(config.agents.openai.model).toBe('gpt-4o-mini');
  });

  it('rechaza un AGENT desconocido', () => {
    expect(() => loadConfig({ ...baseEnv, AGENT: 'copilot' })).toThrow(/Configuracion invalida/);
  });
});
