/**
 * Contratos que debe cumplir cualquier agente (Devin, OpenCode, Codex, Claude Code,
 * OpenAI API...). El nucleo del puente (bridge, monitor, Telegram) solo conoce estos
 * tipos: anadir un agente es escribir un adaptador, no tocar el flujo.
 */

import type { CommandOptions, CommandResult } from '../util/process';

export type AgentName = 'devin' | 'opencode' | 'codex' | 'claude' | 'openai';

/** Ejecutor de procesos inyectable (por defecto `runCommand`). */
export type CommandExecutor = (
  bin: string,
  args: string[],
  options?: CommandOptions
) => Promise<CommandResult>;

/** Orden que se le pasa al agente. */
export interface AgentRunRequest {
  prompt: string;
  /** Sesion a reanudar. Tiene prioridad sobre `allowContinue`. */
  sessionId?: string;
  /** true si ya se ejecuto algo en este directorio y se puede continuar la ultima. */
  allowContinue: boolean;
  cwd: string;
  timeoutMs: number;
  /** Recibe el pid del proceso lanzado, para poder listarlo y detenerlo. */
  onSpawn?: (pid: number) => void;
}

export interface AgentRunResult {
  text: string;
  sessionId?: string;
  durationMs: number;
  exitCode: number;
}

/** Puerto de ejecucion: lanza una orden y devuelve el texto del agente. */
export interface AgentCli {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface SessionSnapshot {
  id: string;
  title: string;
  cwd: string;
  agentMode: string;
  /** Ultima actividad, en milisegundos. */
  lastActivityAt: number;
  lastRole: string;
  lastText: string;
  lastRowId: number;
  state: 'working' | 'idle';
}

export interface ReadSessionsOptions {
  limit?: number;
  withinMs?: number;
  workingWindowMs?: number;
}

/**
 * Puerto de observacion: sesiones recientes del agente (las de su CLI y las de su IDE).
 * Devuelve `[]` si el agente no tiene almacen de sesiones legible.
 */
export interface AgentSessions {
  read(options?: ReadSessionsOptions): SessionSnapshot[];
}

export interface DesktopWindow {
  /** Nombre del proyecto tal y como aparece al principio del titulo de la ventana. */
  project: string;
  title: string;
}

export interface DesktopSendResult {
  sent: boolean;
  reason?: string;
  /** Proyecto (ventana) al que se envio. */
  project?: string;
}

/**
 * Puerto de escritorio: escribe la orden en la UI del agente (su app o la terminal
 * integrada del IDE). Si el agente no tiene UI automatizable, el adaptador devuelve null.
 */
export interface AgentDesktop {
  listWindows(): Promise<DesktopWindow[]>;
  send(prompt: string, project?: string): Promise<DesktopSendResult>;
}

export interface AgentCheck {
  ok: boolean;
  problems: string[];
  notes: string[];
}

/** Todo lo que el puente necesita de un agente. */
export interface AgentAdapter {
  name: AgentName;
  /** Nombre visible en los mensajes ("Devin", "OpenCode"...). */
  label: string;
  cli: AgentCli;
  sessions: AgentSessions | null;
  desktop: AgentDesktop | null;
  /** Comprobaciones previas propias: binario instalado, sesion iniciada... */
  check?(): Promise<AgentCheck>;
}
