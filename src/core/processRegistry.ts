import path from 'node:path';
import { runCommand } from '../util/process';

export interface AgentProcess {
  pid: number;
  /** Agente que lo lanza ('devin', 'opencode'...). */
  agent: string;
  /** Nombre visible ('Devin', 'OpenCode'...). */
  label: string;
  /** Orden que esta ejecutando, si la lanzo el puente. */
  prompt: string;
  chatId?: string;
  startedAt: number;
  /** 'bridge' si lo lanzo el puente; 'external' si ya estaba (IDE, terminal...). */
  source: 'bridge' | 'external';
  /** Linea de comandos, para los externos. */
  commandLine?: string;
}

export interface StopResult {
  stopped: boolean;
  reason?: string;
}

/**
 * Procesos del agente lanzados por el puente. Se registra el pid en cuanto arranca
 * (`onSpawn`) para poder decir al usuario que se esta ejecutando y detenerlo si hace
 * falta; al terminar se quita.
 */
export class ProcessRegistry {
  private readonly items = new Map<number, AgentProcess>();

  add(entry: Omit<AgentProcess, 'source'> & { source?: AgentProcess['source'] }): void {
    this.items.set(entry.pid, { ...entry, source: entry.source ?? 'bridge' });
  }

  remove(pid: number): void {
    this.items.delete(pid);
  }

  get(pid: number): AgentProcess | undefined {
    return this.items.get(pid);
  }

  list(): AgentProcess[] {
    return [...this.items.values()].sort((a, b) => a.startedAt - b.startedAt);
  }
}

export interface ProcessMatchers {
  /** Nombres de ejecutable (para binarios que estan en el PATH). */
  names: string[];
  /** Rutas exactas (para binarios con ruta absoluta: evita confundirlos con la app). */
  paths: string[];
}

/**
 * Como reconocer los procesos de cada agente. Si el binario es una ruta absoluta se
 * compara la ruta completa: asi `devin.exe` del CLI no se confunde con `Devin.exe` de la
 * app de escritorio. Si es solo un nombre, se compara el nombre del ejecutable.
 */
export function agentProcessMatchers(bins: string[]): ProcessMatchers {
  const names = new Set<string>();
  const paths = new Set<string>();

  for (const bin of bins) {
    if (!bin) continue;
    if (path.isAbsolute(bin)) {
      paths.add(path.resolve(bin).toLowerCase());
      continue;
    }
    const base = path.basename(bin).toLowerCase();
    names.add(base);
    names.add(base.endsWith('.exe') ? base.slice(0, -4) : `${base}.exe`);
  }

  return { names: [...names], paths: [...paths] };
}

/** Compatibilidad: solo los nombres, sin rutas. */
export function agentProcessNames(bins: string[]): string[] {
  return agentProcessMatchers(bins).names;
}

interface CimProcess {
  ProcessId?: number;
  Name?: string;
  CommandLine?: string | null;
  CreationDate?: string | null;
}

/** `ConvertTo-Json` de PowerShell 5.1 serializa DateTime como "/Date(1794...)/". */
function parseCimDate(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = /\/Date\((\d+)\)\//.exec(value);
  if (ms) return Number(ms[1]);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Procesos del agente que no lanzo el puente (los de la terminal del IDE, por ejemplo).
 * Se consultan por nombre/ruta con CIM, que en Windows no necesita permisos especiales.
 */
export async function listExternalAgentProcesses(matchers: ProcessMatchers): Promise<AgentProcess[]> {
  if (process.platform !== 'win32') return [];
  if (matchers.names.length === 0 && matchers.paths.length === 0) return [];

  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`;
  const names = matchers.names.map(quote).join(',');
  const paths = matchers.paths.map(quote).join(',');

  // La app de escritorio de Devin se llama igual que el CLI (Devin.exe vs devin.exe):
  // nunca se lista, para que nadie la mate desde el bot.
  // Las sentencias van separadas por saltos de linea: unirlas con espacios da error de
  // analisis en PowerShell ("token inesperado").
  const script = [
    `$names = @(${names})`,
    `$paths = @(${paths})`,
    'Get-CimInstance Win32_Process |',
    '  Where-Object {',
    '    if (-not $_.Name) { return $false }',
    "    $exe = ''",
    '    if ($_.ExecutablePath) { $exe = $_.ExecutablePath.ToLower() }',
    "    if ($exe -and $exe.Contains('\\programs\\devin\\')) { return $false }",
    '    ($names -contains $_.Name.ToLower()) -or ($exe -and ($paths -contains $exe))',
    '  } |',
    '  Select-Object ProcessId, Name, CommandLine, CreationDate |',
    '  ConvertTo-Json -Compress'
  ].join('\n');

  try {
    const result = await runCommand('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      timeoutMs: 20_000
    });
    if (result.code !== 0) return [];

    const raw = result.stdout.trim();
    if (!raw) return [];

    const parsed = JSON.parse(raw) as CimProcess | CimProcess[];
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items
      .filter((item) => typeof item.ProcessId === 'number')
      .map((item) => ({
        pid: item.ProcessId as number,
        agent: (item.Name ?? '').replace(/\.exe$/i, '').toLowerCase(),
        label: (item.Name ?? 'proceso').replace(/\.exe$/i, ''),
        prompt: '',
        startedAt: parseCimDate(item.CreationDate) || Date.now(),
        source: 'external' as const,
        commandLine: (item.CommandLine ?? '').slice(0, 300)
      }));
  } catch {
    return [];
  }
}

/** Mata el arbol del proceso (Windows: taskkill /T /F). */
export async function stopProcessByPid(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    if (process.platform === 'win32') {
      const result = await runCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 20_000 });
      return result.code === 0;
    }
    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
