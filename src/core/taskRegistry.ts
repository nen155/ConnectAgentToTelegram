import { randomUUID } from 'node:crypto';

export type TaskState = 'queued' | 'working' | 'replying' | 'done' | 'error';

export interface TaskRecord {
  id: string;
  chatId: string;
  prompt: string;
  state: TaskState;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  sessionId?: string;
  exitCode?: number;
  error?: string;
}

export type TaskSnapshot = TaskRecord;

const MAX_RECORDS = 20;
const ACTIVE_STATES: TaskState[] = ['queued', 'working', 'replying'];

/**
 * Historial en memoria de las ordenes, para que el panel de la bandeja pueda mostrar
 * que hay en curso y que se acaba de hacer. No persiste: al reiniciar el puente se vacia.
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>();

  create(input: { chatId: string; prompt: string }): TaskRecord {
    const record: TaskRecord = {
      id: randomUUID(),
      chatId: input.chatId,
      prompt: input.prompt,
      state: 'queued',
      queuedAt: Date.now()
    };
    this.tasks.set(record.id, record);
    this.prune();
    return record;
  }

  update(id: string, patch: Partial<Omit<TaskRecord, 'id' | 'chatId'>>): TaskRecord | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;

    const next: TaskRecord = { ...current, ...patch };
    this.tasks.set(id, next);
    return next;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  active(): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => ACTIVE_STATES.includes(task.state))
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  recent(limit = 8): TaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => task.state === 'done' || task.state === 'error')
      .sort((a, b) => (b.finishedAt ?? b.queuedAt) - (a.finishedAt ?? a.queuedAt))
      .slice(0, limit);
  }

  snapshot(): { active: TaskRecord[]; recent: TaskRecord[] } {
    return { active: this.active(), recent: this.recent() };
  }

  private prune(): void {
    if (this.tasks.size <= MAX_RECORDS) return;

    const finished = [...this.tasks.values()]
      .filter((task) => task.state === 'done' || task.state === 'error')
      .sort((a, b) => (a.finishedAt ?? a.queuedAt) - (b.finishedAt ?? b.queuedAt));

    for (const task of finished) {
      if (this.tasks.size <= MAX_RECORDS) break;
      this.tasks.delete(task.id);
    }
  }
}
