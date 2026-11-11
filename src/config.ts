import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AgentName } from './agents/types';

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

const extraArgs = z
  .string()
  .default('')
  .transform((value) => value.split(' ').map((arg) => arg.trim()).filter(Boolean));

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().trim().min(1, 'Falta TELEGRAM_BOT_TOKEN: crea el bot con @BotFather'),
  TELEGRAM_ALLOWED_USER_IDS: csvList,

  /** Agente que ejecuta las ordenes: devin, opencode, codex, claude u openai. */
  AGENT: z.enum(['devin', 'opencode', 'codex', 'claude', 'openai']).default('devin'),
  AGENT_WORKDIR: z.string().trim().optional(),
  AGENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  AGENT_CONTINUITY: z.enum(['auto', 'new', 'continue']).optional(),
  /** auto: reanuda la sesion del IDE; desktop: escribe en la UI del agente; chat: sesion propia. */
  AGENT_ROUTE: z.enum(['auto', 'desktop', 'chat']).optional(),

  // --- Devin ---
  DEVIN_BIN: z.string().trim().optional(),
  DEVIN_WORKDIR: z.string().trim().optional(),
  DEVIN_PERMISSION_MODE: z.enum(['normal', 'accept-edits', 'smart', 'dangerous', 'yolo', 'bypass']).default('dangerous'),
  DEVIN_MODEL: z.string().trim().optional(),
  DEVIN_TIMEOUT_MS: z.coerce.number().int().positive().default(20 * 60 * 1000),
  DEVIN_CONTINUITY: z.enum(['auto', 'new', 'continue']).default('auto'),
  DEVIN_ROUTE: z.enum(['auto', 'desktop', 'chat']).default('auto'),
  DEVIN_EXTRA_ARGS: extraArgs,
  DEVIN_SESSIONS_DB: z.string().trim().optional(),

  // --- OpenCode ---
  OPENCODE_BIN: z.string().trim().default('opencode'),
  OPENCODE_MODEL: z.string().trim().optional(),
  OPENCODE_AGENT: z.string().trim().optional(),
  OPENCODE_SKIP_PERMISSIONS: booleanish(true),
  OPENCODE_EXTRA_ARGS: extraArgs,
  OPENCODE_SESSIONS_DB: z.string().trim().optional(),
  OPENCODE_TERMINAL_PATTERN: z.string().trim().default('opencode'),

  // --- Codex (OpenAI CLI) ---
  CODEX_BIN: z.string().trim().default('codex'),
  CODEX_MODEL: z.string().trim().optional(),
  CODEX_FULL_AUTO: booleanish(true),
  CODEX_SKIP_GIT_CHECK: booleanish(true),
  CODEX_EXTRA_ARGS: extraArgs,
  CODEX_SESSIONS_DIR: z.string().trim().optional(),
  CODEX_TERMINAL_PATTERN: z.string().trim().default('codex'),

  // --- Claude Code ---
  CLAUDE_BIN: z.string().trim().default('claude'),
  CLAUDE_MODEL: z.string().trim().optional(),
  CLAUDE_PERMISSION_MODE: z
    .enum(['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'])
    .default('bypassPermissions'),
  CLAUDE_EXTRA_ARGS: extraArgs,
  CLAUDE_PROJECTS_DIR: z.string().trim().optional(),
  CLAUDE_TERMINAL_PATTERN: z.string().trim().default('claude'),

  // --- OpenAI API (sin CLI) ---
  OPENAI_API_KEY: z.string().trim().optional(),
  OPENAI_BASE_URL: z.string().trim().default('https://api.openai.com/v1'),
  OPENAI_MODEL: z.string().trim().default('gpt-4o-mini'),
  OPENAI_MAX_TOKENS: z.coerce.number().int().positive().optional(),
  OPENAI_TEMPERATURE: z.coerce.number().min(0).max(2).optional(),
  OPENAI_SYSTEM_PROMPT: z.string().trim().optional(),

  /** Titulo de las ventanas del IDE: se antepone al nombre del proyecto. */
  IDE_WINDOW_SUFFIX: z.string().default(' - Devin'),

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
  /** Idioma en el que se pide al agente el resumen (vacio = no forzar). */
  SUMMARY_LANGUAGE: z.enum(['', 'es', 'en']).default('es'),

  /** Sustituye transcripcion y agente por mocks: util para probar el puente sin cuentas. */
  MOCK_MODE: booleanish(false)
});

export type PermissionMode = 'normal' | 'accept-edits' | 'smart' | 'dangerous';
export type RouteMode = 'auto' | 'desktop' | 'chat';
export type ContinuityMode = 'auto' | 'new' | 'continue';

/** Ajustes comunes a todos los agentes. */
export interface AgentRuntimeConfig {
  name: AgentName;
  label: string;
  workdir: string;
  /** Nombre de la carpeta del proyecto: prefijo del titulo de la ventana del IDE. */
  projectName: string;
  timeoutMs: number;
  continuity: ContinuityMode;
  route: RouteMode;
}

export interface DesktopScripts {
  /** Script que escribe en la ventana de Devin Desktop. */
  desktop: string;
  /** Script que escribe en la terminal integrada del IDE. */
  terminal: string;
}

export interface DevinSettings {
  bin: string;
  permissionMode: PermissionMode;
  model?: string;
  extraArgs: string[];
  /** Base de sesiones del CLI (y del IDE), para observar y resumir tareas. */
  sessionsDb: string;
  windowSuffix: string;
  scripts: DesktopScripts;
}

export interface OpenCodeSettings {
  bin: string;
  model?: string;
  agent?: string;
  skipPermissions: boolean;
  extraArgs: string[];
  sessionsDb: string;
  windowSuffix: string;
  terminalPattern: string;
  scripts: DesktopScripts;
}

export interface CodexSettings {
  bin: string;
  model?: string;
  fullAuto: boolean;
  skipGitRepoCheck: boolean;
  extraArgs: string[];
  sessionsDir: string;
  windowSuffix: string;
  terminalPattern: string;
  scripts: DesktopScripts;
}

export interface ClaudeSettings {
  bin: string;
  model?: string;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';
  extraArgs: string[];
  projectsDir: string;
  windowSuffix: string;
  terminalPattern: string;
  scripts: DesktopScripts;
}

export interface OpenAiSettings {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface AppConfig {
  telegram: { token: string; allowedUserIds: number[] };
  agent: AgentRuntimeConfig;
  agents: {
    devin: DevinSettings;
    opencode: OpenCodeSettings;
    codex: CodexSettings;
    claude: ClaudeSettings;
    openai: OpenAiSettings;
  };
  whisper: { bin: string; model: string; language: string; threads: number; timeoutMs: number };
  tts: { enabled: boolean; voice?: string; rate: number; maxChars: number };
  ffmpegBin: string;
  paths: {
    data: string;
    tmp: string;
    sessionsFile: string;
    logFile: string;
    ttsScript: string;
    statusFile: string;
    replyRoutesFile: string;
    sendToDesktopScript: string;
    sendToTerminalScript: string;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Idioma forzado para el resumen del agente ('es', 'en' o '' para no forzar). */
  summaryLanguage: '' | 'es' | 'en';
  mockMode: boolean;
}

const AGENT_LABELS: Record<AgentName, string> = {
  devin: 'Devin',
  opencode: 'OpenCode',
  codex: 'Codex',
  claude: 'Claude Code',
  openai: 'OpenAI'
};

/** Resumen legible de los permisos del agente elegido, para /status. */
export function describeAgent(config: AppConfig): string {
  switch (config.agent.name) {
    case 'devin':
      return `permisos ${config.agents.devin.permissionMode}`;
    case 'opencode':
      return config.agents.opencode.skipPermissions ? 'sin confirmaciones' : 'con confirmaciones';
    case 'codex':
      return config.agents.codex.fullAuto ? 'full-auto' : 'con aprobaciones';
    case 'claude':
      return `permisos ${config.agents.claude.permissionMode}`;
    case 'openai':
      return config.agents.openai.model;
    default:
      return config.agent.name;
  }
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

function resolveBin(configured: string): string {
  // Un binario instalado por npm/pnpm suele estar en el PATH; si el nombre incluye
  // separadores, se respeta tal cual.
  if (configured.includes('/') || configured.includes('\\')) return path.resolve(configured);
  return configured;
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

  const scripts: DesktopScripts = {
    desktop: path.join(PROJECT_ROOT, 'scripts', 'send-to-desktop.ps1'),
    terminal: path.join(PROJECT_ROOT, 'scripts', 'send-to-terminal.ps1')
  };

  // Los nombres genericos (AGENT_*) mandan; si no estan, se aceptan los historicos
  // (DEVIN_*) para no romper los .env existentes.
  const name = values.AGENT;
  const workdir = path.resolve(values.AGENT_WORKDIR ?? values.DEVIN_WORKDIR ?? PROJECT_ROOT);
  const windowSuffix = values.IDE_WINDOW_SUFFIX;

  return {
    telegram: { token: values.TELEGRAM_BOT_TOKEN, allowedUserIds },
    agent: {
      name,
      label: AGENT_LABELS[name],
      workdir,
      projectName: path.basename(workdir),
      timeoutMs: values.AGENT_TIMEOUT_MS ?? values.DEVIN_TIMEOUT_MS,
      continuity: values.AGENT_CONTINUITY ?? values.DEVIN_CONTINUITY,
      route: values.AGENT_ROUTE ?? values.DEVIN_ROUTE
    },
    agents: {
      devin: {
        bin: resolveDevinBin(values.DEVIN_BIN),
        permissionMode:
          values.DEVIN_PERMISSION_MODE === 'yolo' || values.DEVIN_PERMISSION_MODE === 'bypass'
            ? 'dangerous'
            : values.DEVIN_PERMISSION_MODE,
        model: values.DEVIN_MODEL,
        extraArgs: values.DEVIN_EXTRA_ARGS,
        sessionsDb: path.resolve(
          values.DEVIN_SESSIONS_DB ?? path.join(process.env.APPDATA ?? '', 'devin', 'cli', 'sessions.db')
        ),
        windowSuffix,
        scripts
      },
      opencode: {
        bin: resolveBin(values.OPENCODE_BIN),
        model: values.OPENCODE_MODEL,
        agent: values.OPENCODE_AGENT,
        skipPermissions: values.OPENCODE_SKIP_PERMISSIONS,
        extraArgs: values.OPENCODE_EXTRA_ARGS,
        sessionsDb: path.resolve(
          values.OPENCODE_SESSIONS_DB ??
            path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.local', 'share', 'opencode', 'opencode.db')
        ),
        windowSuffix,
        terminalPattern: values.OPENCODE_TERMINAL_PATTERN,
        scripts
      },
      codex: {
        bin: resolveBin(values.CODEX_BIN),
        model: values.CODEX_MODEL,
        fullAuto: values.CODEX_FULL_AUTO,
        skipGitRepoCheck: values.CODEX_SKIP_GIT_CHECK,
        extraArgs: values.CODEX_EXTRA_ARGS,
        sessionsDir: path.resolve(
          values.CODEX_SESSIONS_DIR ??
            path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.codex', 'sessions')
        ),
        windowSuffix,
        terminalPattern: values.CODEX_TERMINAL_PATTERN,
        scripts
      },
      claude: {
        bin: resolveBin(values.CLAUDE_BIN),
        model: values.CLAUDE_MODEL,
        permissionMode: values.CLAUDE_PERMISSION_MODE,
        extraArgs: values.CLAUDE_EXTRA_ARGS,
        projectsDir: path.resolve(
          values.CLAUDE_PROJECTS_DIR ??
            path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.claude', 'projects')
        ),
        windowSuffix,
        terminalPattern: values.CLAUDE_TERMINAL_PATTERN,
        scripts
      },
      openai: {
        apiKey: values.OPENAI_API_KEY,
        baseUrl: values.OPENAI_BASE_URL,
        model: values.OPENAI_MODEL,
        maxTokens: values.OPENAI_MAX_TOKENS,
        temperature: values.OPENAI_TEMPERATURE,
        systemPrompt: values.OPENAI_SYSTEM_PROMPT
      }
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
      statusFile: path.join(dataDir, 'status.json'),
      replyRoutesFile: path.join(dataDir, 'reply-routes.json'),
      sendToDesktopScript: scripts.desktop,
      sendToTerminalScript: scripts.terminal
    },
    logLevel: values.LOG_LEVEL,
    summaryLanguage: values.SUMMARY_LANGUAGE,
    mockMode: values.MOCK_MODE
  };
}
