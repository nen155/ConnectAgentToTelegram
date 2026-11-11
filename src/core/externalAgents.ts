import type { Logger } from '../logger';
import { runCommand } from '../util/process';
import { formatDuration } from '../util/format';

export interface ExternalTask {
  id: string;
  chatId: string;
  prompt: string;
  state: 'working' | 'done';
  queuedAt: number;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  source: 'external';
}

export interface RawProcess {
  pid: number;
  parentPid: number;
  commandLine: string;
  startedAt: number;
}

export type ProcessLister = () => Promise<RawProcess[]>;

const PS_LIST = [
  "Get-CimInstance Win32_Process -Filter \"Name='devin.exe'\" |",
  " Where-Object { $_.ExecutablePath -like '*\\devin\\cli\\bin\\devin.exe' } |",
  ' Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate |',
  ' ConvertTo-Json -Compress'
].join('');

function parseStartedAt(value: unknown): number {
  if (typeof value === 'string') {
    const iso = Date.parse(value);
    if (!Number.isNaN(iso)) return iso;
    const ms = /\/Date\((\d+)\)\//.exec(value);
    if (ms?.[1]) return Number(ms[1]);
  }
  return Date.now();
}

/** Lista los procesos del CLI de Devin vivos en la maquina (no incluye Devin Desktop ni Cloud). */
export const listDevinCliProcesses: ProcessLister = async () => {
  const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], {
    timeoutMs: 15_000
  });
  if (result.code !== 0) return [];

  const raw = result.stdout.trim();
  if (!raw) return [];

  const parsed = JSON.parse(raw) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];

  return items.map((item) => {
    const record = item as Record<string, unknown>;
    return {
      pid: Number(record.ProcessId),
      parentPid: Number(record.ParentProcessId),
      commandLine: String(record.CommandLine ?? ''),
      startedAt: parseStartedAt(record.CreationDate)
    };
  });
};

/** De `devin.exe ... -p -- "revisa el readme"` saca la orden; si no la reconoce, deja el comando. */
export function extractPrompt(commandLine: string): string {
  const separator = commandLine.indexOf(' -- ');
  if (separator >= 0) {
    return commandLine
      .slice(separator + 4)
      .replace(/^["']|["']$/g, '')
      .trim();
  }
  return commandLine.trim();
}

/** Mensaje que recibe el usuario cuando termina una tarea lanzada fuera del puente. */
export function formatExternalTask(task: ExternalTask, digest?: { title?: string; summary?: string } | null): string {
  const prompt = task.prompt.length > 200 ? `${task.prompt.slice(0, 197)}...` : task.prompt;
  const lines = [
    '✅ Tarea de Devin terminada (otra sesion, no lanzada desde Telegram)',
    `Duracion: ${formatDuration(task.durationMs ?? 0)}`,
    `Orden: "${prompt}"`
  ];

  const summary = digest?.summary?.trim();
  if (summary) {
    lines.push('', 'Resumen de lo que hizo:', summary);
  } else if (digest?.title) {
    lines.push('', `Sesion: ${digest.title}`);
  } else {
    lines.push('', 'No pude leer el resumen de esa sesion (base de sesiones no accesible).');
  }

  return lines.join('\n');
}

export interface ExternalAgentWatcherOptions {
  listProcesses?: ProcessLister;
  onFinished: (task: ExternalTask) => void;
  /** Se llama cuando aparece o desaparece una tarea, para refrescar el estado publicado. */
  onChanged?: () => void;
  logger: Logger;
  /** PID del propio puente: sus hijos son las ordenes que ya avisa el bot. */
  excludePid?: number;
  pollMs?: number;
  maxRecent?: number;
}

/**
 * Vigila los agentes de Devin CLI que no lanza el puente. Cuando uno desaparece de la lista
 * de procesos se considera terminado: se guarda en el historial y se avisa por callback.
 */
export class ExternalAgentWatcher {
  private readonly running = new Map<number, ExternalTask>();
  private recentTasks: ExternalTask[] = [];
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly options: ExternalAgentWatcherOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.options.pollMs ?? 5000;
    this.timer = setInterval(() => void this.poll(), interval);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;

    try {
      const listProcesses = this.options.listProcesses ?? listDevinCliProcesses;
      const processes = await listProcesses().catch((error: unknown) => {
        this.options.logger.warn('No pude listar procesos de Devin', error);
        return [] as RawProcess[];
      });

      const seen = new Set<number>();
      let changed = false;

      // devin.exe lanza un proceso hijo que tambien coincide con el filtro: se descarta
      // para no contar (ni avisar) dos veces de la misma tarea.
      const detectedPids = new Set(processes.map((process) => process.pid));

      for (const process of processes) {
        if (!Number.isFinite(process.pid)) continue;
        if (this.options.excludePid && process.parentPid === this.options.excludePid) continue;
        if (process.parentPid !== process.pid && detectedPids.has(process.parentPid)) continue;

        seen.add(process.pid);
        if (!this.running.has(process.pid)) {
          this.running.set(process.pid, {
            id: `ext-${process.pid}`,
            chatId: 'external',
            prompt: extractPrompt(process.commandLine) || `Devin CLI (PID ${process.pid})`,
            state: 'working',
            queuedAt: process.startedAt,
            startedAt: process.startedAt,
            source: 'external'
          });
          changed = true;
          this.options.logger.info('Detectado agente de Devin externo', { pid: process.pid });
        }
      }

      for (const [pid, task] of [...this.running.entries()]) {
        if (seen.has(pid)) continue;

        this.running.delete(pid);
        changed = true;
        const finished: ExternalTask = {
          ...task,
          state: 'done',
          finishedAt: Date.now(),
          durationMs: Date.now() - task.startedAt
        };

        const maxRecent = this.options.maxRecent ?? 5;
        this.recentTasks = [finished, ...this.recentTasks].slice(0, maxRecent);

        try {
          this.options.onFinished(finished);
        } catch (error) {
          this.options.logger.warn('Fallo el aviso de tarea externa', error);
        }
      }

      if (changed) this.options.onChanged?.();
    } finally {
      this.polling = false;
    }
  }

  active(): ExternalTask[] {
    return [...this.running.values()];
  }

  recent(): ExternalTask[] {
    return this.recentTasks;
  }
}
