/**
 * Demo sin credenciales ni dependencias externas: recorre el mismo pipeline que el bot
 * (transcripcion -> orden -> resumen) usando los mocks y escribiendo en la consola.
 *
 * Uso: npm run demo
 */
import fs from 'node:fs/promises';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';
import { CommandBridge, type Notifier } from '../src/core/bridge';
import { KeyedQueue } from '../src/core/taskQueue';
import { SessionStore } from '../src/devin/sessionStore';
import { MockDevinRunner, MockTranscriber } from '../src/mocks';

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, TELEGRAM_BOT_TOKEN: 'demo' });
  await fs.mkdir(config.paths.data, { recursive: true });

  const store = new SessionStore(config.paths.sessionsFile);
  await store.load();

  const bridge = new CommandBridge({
    runner: new MockDevinRunner(),
    transcriber: new MockTranscriber(),
    tts: null,
    store,
    queue: new KeyedQueue(),
    config,
    logger: createLogger({ level: 'warn' })
  });

  const notifier: Notifier = {
    text: async (message) => console.log(`\n[BOT] ${message}`),
    voice: async () => undefined
  };

  console.log('Demo con mocks: no se llama a Devin, whisper ni Telegram.\n');

  console.log('--- 1) Llega una nota de voz ---');
  await bridge.handleVoice('demo', 'audio-simulado.ogg', notifier);

  console.log('\n--- 2) Llega una orden escrita (misma sesion) ---');
  await bridge.handlePrompt('demo', 'ordena los archivos por tamano', notifier);

  console.log('\nFin de la demo.');
}

void main().catch((error: unknown) => {
  console.error(`Fallo la demo: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
