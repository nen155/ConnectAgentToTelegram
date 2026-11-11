import fs from 'node:fs/promises';
import path from 'node:path';
import type { TaskSnapshot } from './taskRegistry';
import type { SessionSnapshot } from './sessionMonitor';

export type BridgeState = 'idle' | 'transcribing' | 'working' | 'replying';

export interface StatusSnapshot {
  queue?: number;
  current?: TaskSnapshot;
  active?: TaskSnapshot[];
  recent?: TaskSnapshot[];
  /** Sesiones de Devin (IDE y CLI) con su estado, para el panel de la bandeja. */
  sessions?: SessionSnapshot[];
}

export interface BridgeStatus extends Required<Omit<StatusSnapshot, 'current'>> {
  state: BridgeState;
  updatedAt: number;
  pid: number;
  current?: TaskSnapshot;
}

/**
 * Publica el estado del puente en un JSON que lee el gestor de bandeja.
 * Un fallo al escribir nunca debe romper una orden: el estado es informativo.
 */
export class StatusPublisher {
  constructor(private readonly filePath: string) {}

  async publish(state: BridgeState, snapshot: StatusSnapshot = {}): Promise<void> {
    const payload: BridgeStatus = {
      state,
      updatedAt: Date.now(),
      pid: process.pid,
      queue: snapshot.queue ?? 0,
      active: snapshot.active ?? [],
      recent: snapshot.recent ?? [],
      sessions: snapshot.sessions ?? [],
      ...(snapshot.current ? { current: snapshot.current } : {})
    };

    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
      await fs.rename(tmp, this.filePath);
    } catch {
      // Silencioso a proposito: el estado es solo para la bandeja.
    }
  }
}
