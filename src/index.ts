import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config';
import { createLogger } from './logger';
import { KeyedQueue } from './core/taskQueue';
import { CommandBridge } from './core/bridge';
import {
  SessionMonitor,
  findProjectSession,
  formatFinishedSession,
  readSessions,
  type SessionSnapshot
} from './core/sessionMonitor';
import { StatusPublisher } from './core/statusPublisher';
import { acquireLock, releaseLock } from './core/singleInstance';
import { SessionStore } from './devin/sessionStore';
import { DesktopRouter } from './devin/desktopRouter';
import { DevinRunner } from './devin/devinRunner';
import { WhisperCppTranscriber } from './audio/whisper';
import { WindowsSapiTts } from './audio/tts';
import { MockDevinRunner, MockTranscriber } from './mocks';
import { createTelegramBot, splitMessage } from './telegram/bot';
import { ReplyRouteStore } from './telegram/replyRoutes';
import { markdownToTelegramHtml } from './telegram/format';
import { formatReadiness, inspectReadiness } from './readiness';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, file: config.paths.logFile });
  const lockFile = path.join(config.paths.data, 'bridge.lock');

  const lock = await acquireLock(lockFile);
  if (!lock.acquired) {
    const holder = lock.holder ? ` (PID ${lock.holder.pid})` : '';
    process.stdout.write(`Ya hay un puente en ejecucion${holder}; esta instancia se cierra.\n`);
    return;
  }

  const release = async (): Promise<void> => {
    await releaseLock(lockFile).catch(() => undefined);
  };
  process.once('exit', () => {
    void release();
  });

  if (config.telegram.allowedUserIds.length === 0) {
    logger.warn(
      'TELEGRAM_ALLOWED_USER_IDS esta vacio: el bot solo respondera con el user id de quien escriba, sin ejecutar ordenes.'
    );
  }

  await fs.mkdir(config.paths.tmp, { recursive: true });
  await fs.mkdir(config.paths.data, { recursive: true });

  const readiness = await inspectReadiness(config);
  if (readiness.ok) {
    logger.info('Comprobaciones previas OK');
  } else {
    logger.warn(`Comprobaciones previas con pendientes:\n${formatReadiness(readiness)}`);
  }

  const store = new SessionStore(config.paths.sessionsFile);
  await store.load();

  if (config.mockMode) {
    logger.warn('MOCK_MODE activo: la transcripcion y las respuestas son simuladas (no se llama a Devin ni a whisper).');
  }

  const transcriber = config.mockMode
    ? new MockTranscriber()
    : new WhisperCppTranscriber({
        bin: config.whisper.bin,
        model: config.whisper.model,
        language: config.whisper.language,
        threads: config.whisper.threads,
        timeoutMs: config.whisper.timeoutMs,
        ffmpegBin: config.ffmpegBin,
        tmpDir: config.paths.tmp
      });

  const tts = config.tts.enabled
    ? new WindowsSapiTts({
        scriptPath: config.paths.ttsScript,
        voice: config.tts.voice,
        rate: config.tts.rate,
        maxChars: config.tts.maxChars,
        ffmpegBin: config.ffmpegBin,
        tmpDir: config.paths.tmp
      })
    : null;

  const runner = config.mockMode
    ? new MockDevinRunner()
    : new DevinRunner({
        bin: config.devin.bin,
        permissionMode: config.devin.permissionMode,
        model: config.devin.model,
        extraArgs: config.devin.extraArgs,
        tmpDir: config.paths.tmp
      });

  const replyRoutes = new ReplyRouteStore(config.paths.replyRoutesFile);
  await replyRoutes.load();

  const queue = new KeyedQueue();
  const status = new StatusPublisher(config.paths.statusFile);
  await status.publish('idle');

  // El monitor y el puente se necesitan mutuamente: se enlazan por estas funciones.
  let notifyFinishedSession: (session: SessionSnapshot) => void = () => undefined;
  let refreshStatus: () => void = () => undefined;

  const monitor = new SessionMonitor({
    dbPath: config.devin.sessionsDb,
    logger,
    onFinished: (session) => notifyFinishedSession(session),
    onChanged: () => refreshStatus(),
    // Las sesiones que lanza el propio bot ya reciben su resumen normal.
    ignoreIds: () =>
      new Set(
        store
          .list()
          .map(([, session]) => session.sessionId)
          .filter((id): id is string => Boolean(id))
      )
  });

  const bridge = new CommandBridge({
    runner,
    transcriber,
    tts,
    store,
    queue,
    config,
    logger,
    status,
    sessions: () => monitor.sessions(),
    rememberRoute: (messageId, project) => replyRoutes.remember(messageId, { project }),
    desktop: new DesktopRouter({
      scriptPath: path.join(PROJECT_ROOT, 'scripts', 'send-to-desktop.ps1'),
      tmpDir: config.paths.tmp,
      projectName: config.devin.projectName
    }),
    knownProjects: async () => {
      const sessions = readSessions(config.devin.sessionsDb, { limit: 20, withinMs: 7 * 24 * 60 * 60 * 1000 });
      const names = sessions.map((session) => path.basename(session.cwd)).filter(Boolean);
      return [...new Set(names)];
    },
    resolveIdeSession: async () => {
      const sessions = readSessions(config.devin.sessionsDb, { limit: 20, withinMs: 24 * 60 * 60 * 1000 });
      const ownSessions = new Set(
        store
          .list()
          .map(([, session]) => session.sessionId)
          .filter((id): id is string => Boolean(id))
      );

      const match = findProjectSession(sessions, config.devin.workdir, ownSessions);
      if (!match) return null;
      return { id: match.id, title: match.title, busy: match.state === 'working' };
    }
  });
  refreshStatus = () => void bridge.refreshStatus();

  const bot = createTelegramBot({ config, bridge, store, queue, logger, replyRoutes });

  notifyFinishedSession = (session) => {
    const text = formatFinishedSession(session);
    logger.info('Aviso de sesion terminada', { sesion: session.id, resumenChars: session.lastText.length });

    // El proyecto se guarda junto al mensaje: responder a ese aviso (texto o audio)
    // enruta la orden a ese proyecto sin tener que inferirlo del contenido.
    const project = session.cwd ? path.basename(session.cwd) : '';

    for (const chatId of config.telegram.allowedUserIds) {
      for (const chunk of splitMessage(text)) {
        // Mismo tratamiento que en el bot: el resumen llega en Markdown y hay
        // que convertirlo a HTML para que Telegram lo renderice.
        const html = markdownToTelegramHtml(chunk);
        void bot.api
          .sendMessage(chatId, html, { parse_mode: 'HTML' })
          .catch(() => bot.api.sendMessage(chatId, chunk))
          .then((message) => {
            if (project && message) {
              replyRoutes.remember(message.message_id, { project, sessionId: session.id });
            }
          })
          .catch((error: unknown) => {
            logger.warn('No pude avisar de la sesion terminada', error);
          });
      }
    }
  };

  monitor.start();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Recibido ${signal}; cerrando`);
    monitor.stop();
    await bot.stop().catch(() => undefined);
    await status.publish('idle');
    await release();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));

  await bot.start({
    drop_pending_updates: true,
    onStart: (info) => {
      logger.info(`Escuchando como @${info.username} (${info.first_name})`);
      logger.info(`Carpeta de trabajo: ${config.devin.workdir}`);
    }
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`No se pudo arrancar el puente: ${message}\n`);
  process.exit(1);
});
