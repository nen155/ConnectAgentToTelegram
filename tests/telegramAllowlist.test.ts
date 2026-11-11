import type { AppConfig } from '../src/config';
import type { CommandBridge } from '../src/core/bridge';
import { KeyedQueue } from '../src/core/taskQueue';
import { SessionStore } from '../src/devin/sessionStore';
import { createLogger } from '../src/logger';
import { createTelegramBot } from '../src/telegram/bot';

type BotInstance = ReturnType<typeof createTelegramBot>;
type TelegramUpdate = Parameters<BotInstance['handleUpdate']>[0];

function makeConfig(allowed: number[]): AppConfig {
  return {
    telegram: { token: '123:token-de-prueba', allowedUserIds: allowed },
    devin: { bin: 'devin', workdir: '.', permissionMode: 'dangerous', timeoutMs: 1000, continuity: 'auto', extraArgs: [], sessionsDb: 'sessions.db' },
    whisper: { bin: 'w', model: 'm', language: 'es', threads: 1, timeoutMs: 1000 },
    tts: { enabled: false, rate: 0, maxChars: 100 },
    ffmpegBin: 'ffmpeg',
    paths: { data: '.', tmp: '.', sessionsFile: 's.json', logFile: 'l.log', ttsScript: 's.ps1', statusFile: 'st.json' },
    logLevel: 'error',
    mockMode: false
  };
}

function textUpdate(userId: number, text: string): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: userId, type: 'private', first_name: 'Prueba' },
      from: { id: userId, is_bot: false, first_name: 'Prueba' },
      text
    }
  } as TelegramUpdate;
}

async function runUpdate(allowed: number[], update: TelegramUpdate) {
  const sent: string[] = [];
  const bridge = {
    handlePrompt: jest.fn(async () => undefined),
    handleVoice: jest.fn(async () => undefined)
  } as unknown as CommandBridge;

  const bot = createTelegramBot({
    config: makeConfig(allowed),
    bridge,
    store: new SessionStore('no-se-usa.json'),
    queue: new KeyedQueue(),
    logger: createLogger({ level: 'error' })
  });

  bot.botInfo = { id: 123, is_bot: true, first_name: 'Puente', username: 'puente_bot' } as typeof bot.botInfo;

  bot.api.config.use(async (_prev, _method, payload) => {
    const text = (payload as { text?: string }).text;
    if (text) sent.push(text);
    return { ok: true, result: true } as never;
  });

  await bot.handleUpdate(update);
  return { sent, bridge };
}

describe('allowlist de Telegram', () => {
  it('sin allowlist solo devuelve el user id y no ejecuta nada', async () => {
    const { sent, bridge } = await runUpdate([], textUpdate(999, 'borra todo'));

    expect(sent.join(' ')).toContain('Tu user id es 999');
    expect(bridge.handlePrompt).not.toHaveBeenCalled();
  });

  it('rechaza a un usuario que no esta en la lista', async () => {
    const { sent, bridge } = await runUpdate([111], textUpdate(999, 'borra todo'));

    expect(sent.join(' ')).toContain('No autorizado');
    expect(bridge.handlePrompt).not.toHaveBeenCalled();
  });

  it('deja pasar la orden del usuario autorizado', async () => {
    const { bridge } = await runUpdate([999], textUpdate(999, 'arregla el bug'));

    expect(bridge.handlePrompt).toHaveBeenCalledWith('999', 'arregla el bug', expect.any(Object));
  });

  it('ignora los comandos desconocidos sin ejecutarlos', async () => {
    const { bridge } = await runUpdate([999], textUpdate(999, '/comando-raro'));

    expect(bridge.handlePrompt).not.toHaveBeenCalled();
  });
});
