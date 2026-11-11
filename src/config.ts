import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export const PROJECT_ROOT = path.resolve(__dirname, '..');

const csvList = z
  .string()
  .default('')
  .transform((value) => value.split(',').map((item) => item.trim()).filter(Boolean));

const booleanish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return fallback;
      return ['true', '1', 'yes', 'si', 'sí'].includes(value.trim().toLowerCase());
    });

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, 'Falta TELEGRAM_BOT_TOKEN: crea el bot con @BotFather'),
  TELEGRAM_ALLOWED_USER_IDS: csvList,

  DEVIN_BIN: z.string().trim().optional(),
  DEVIN_WORKDIR: z.string().trim().optional(),
  DEVIN_PERMISSION_MODE: z.enum(['normal', 'accept-edits', 'smart', 'dangerous', 'yolo', 'bypass']).default('dangerous'),
  DEVIN_MODEL: z.string().trim().optional(),
  DEVIN_TIMEOUT_MS: z.coerce.number().int().positive().default(20 * 60 * 1000),
  DEVIN_CONTINUITY: z.enum(['auto', 'new', 'continue']).default('auto'),
  /** auto: reanuda la sesion del IDE; desktop: escribe en la ventana del IDE; chat: sesion propia. */
  DEVIN_ROUTE: z.enum(['auto', 'desktop', 'chat']).default('auto'),
  DEVIN_EXTRA_ARGS: z.string().default(''),
  DEVIN_SESSIONS_DB: z.string().trim().optional(),

  FFMPEG_BIN: z.string().trim().default('ffmpeg'),
  WHISPER_BIN: z.string().trim().optional(),
  WHISPER_MODEL: z.string().trim().optional(),
  WHISPER_LANG: z.string().trim().default('es'),
  WHISPER_THREADS: z.coerce.number().int().positive().default(Math.min(8, Math.max(1, os.cpus().length))),
  WHISPER_TIMEOUT_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),

  TTS_ENABLED: booleanish(true),
  TTS_VOICE: z.string().trim().optional(),
  TTS_RATE: z.coerce.number().int().min(-10).max(10).default(0),
  TTS_MAX_CHARS: z.coerce.number().int().positive().default(1200),

  DATA_DIR: z.string().trim().optional(),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  /** Sustituye transcripcion y Devin por mocks: util para probar el puente sin cuentas. */
  MOCK_MODE: booleanish(false)
});

export type PermissionMode = 'normal' | 'accept-edits' | 'smart' | 'dangerous';

export interface AppConfig {
  telegram: { token: string; allowedUserIds: number[] };
  devin: {
    bin: string;
    workdir: string;
    permissionMode: PermissionMode;
    model?: string;
    timeoutMs: number;
    continuity: 'auto' | 'new' | 'continue';
    route: 'auto' | 'desktop' | 'chat';
    /** Nombre de la carpeta del proyecto: prefijo del titulo de la ventana del IDE. */
    projectName: string;
    extraArgs: string[];
    /** Base de sesiones del CLI, para resumir tareas lanzadas fuera del puente. */
    sessionsDb: string;
  };
  whisper: { bin: string; model: string; language: string; threads: number; timeoutMs: number };
  tts: { enabled: boolean; voice?: string; rate: number; maxChars: number };
  ffmpegBin: string;
  paths: { data: string; tmp: string; sessionsFile: string; logFile: string; ttsScript: string; statusFile: string };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  mockMode: boolean;
}

function firstExisting(candidates: Array<string | undefined>, fallback: string): string {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}

function resolveDevinBin(configured?: string): string {
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA ?? '';
  return firstExisting([path.join(localAppData, 'devin', 'cli', 'bin', 'devin.exe')], 'devin');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `- ${issue.path.join('.') || 'env'}: ${issue.message}`);
    throw new Error(`Configuracion invalida:\n${details.join('\n')}`);
  }
  const values = parsed.data;
  const dataDir = path.resolve(values.DATA_DIR ?? path.join(PROJECT_ROOT, 'data'));
  const vendorDir = path.join(PROJECT_ROOT, 'vendor');

  const allowedUserIds = values.TELEGRAM_ALLOWED_USER_IDS.map((id) => Number(id));
  if (allowedUserIds.some((id) => !Number.isInteger(id))) {
    throw new Error('TELEGRAM_ALLOWED_USER_IDS debe contener solo IDs numericos separados por comas');
  }

  return {
    telegram: { token: values.TELEGRAM_BOT_TOKEN, allowedUserIds },
    devin: {
      bin: resolveDevinBin(values.DEVIN_BIN),
      workdir: path.resolve(values.DEVIN_WORKDIR ?? PROJECT_ROOT),
      permissionMode: values.DEVIN_PERMISSION_MODE === 'yolo' || values.DEVIN_PERMISSION_MODE === 'bypass'
        ? 'dangerous'
        : values.DEVIN_PERMISSION_MODE,
      model: values.DEVIN_MODEL,
      timeoutMs: values.DEVIN_TIMEOUT_MS,
      continuity: values.DEVIN_CONTINUITY,
      route: values.DEVIN_ROUTE,
      projectName: path.basename(path.resolve(values.DEVIN_WORKDIR ?? PROJECT_ROOT)),
      extraArgs: values.DEVIN_EXTRA_ARGS.split(' ').map((arg) => arg.trim()).filter(Boolean),
      sessionsDb: path.resolve(
        values.DEVIN_SESSIONS_DB ?? path.join(process.env.APPDATA ?? '', 'devin', 'cli', 'sessions.db')
      )
    },
    whisper: {
      bin: path.resolve(values.WHISPER_BIN ?? path.join(vendorDir, 'whisper', 'whisper-cli.exe')),
      model: path.resolve(values.WHISPER_MODEL ?? path.join(vendorDir, 'models', 'ggml-small.bin')),
      language: values.WHISPER_LANG,
      threads: values.WHISPER_THREADS,
      timeoutMs: values.WHISPER_TIMEOUT_MS
    },
    tts: {
      enabled: values.TTS_ENABLED,
      voice: values.TTS_VOICE,
      rate: values.TTS_RATE,
      maxChars: values.TTS_MAX_CHARS
    },
    ffmpegBin: values.FFMPEG_BIN,
    paths: {
      data: dataDir,
      tmp: path.join(dataDir, 'tmp'),
      sessionsFile: path.join(dataDir, 'sessions.json'),
      logFile: path.join(dataDir, 'logs', 'bridge.log'),
      ttsScript: path.join(PROJECT_ROOT, 'scripts', 'sapi-tts.ps1'),
      statusFile: path.join(dataDir, 'status.json')
    },
    logLevel: values.LOG_LEVEL,
    mockMode: values.MOCK_MODE
  };
}
