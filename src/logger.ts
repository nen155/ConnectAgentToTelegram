import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(scope: string): Logger;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) return ` ${meta.message}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export function createLogger(options: { level: LogLevel; file?: string; scope?: string }): Logger {
  const threshold = LEVEL_WEIGHT[options.level];

  if (options.file) {
    fs.mkdirSync(path.dirname(options.file), { recursive: true });
  }

  const write = (level: LogLevel, scope: string, message: string, meta?: unknown) => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}${formatMeta(meta)}`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(`${line}\n`);
    } else {
      process.stdout.write(`${line}\n`);
    }
    if (options.file) {
      try {
        fs.appendFileSync(options.file, `${line}\n`);
      } catch {
        // Un fallo al escribir el log nunca debe tumbar el puente.
      }
    }
  };

  const build = (scope: string): Logger => ({
    debug: (message, meta) => write('debug', scope, message, meta),
    info: (message, meta) => write('info', scope, message, meta),
    warn: (message, meta) => write('warn', scope, message, meta),
    error: (message, meta) => write('error', scope, message, meta),
    child: (childScope) => build(`${scope}:${childScope}`)
  });

  return build(options.scope ?? 'app');
}
