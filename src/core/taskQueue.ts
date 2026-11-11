/**
 * Cola FIFO por clave (chat). Garantiza que dos ordenes del mismo chat no se pisen
 * y que el hilo de Devin avance en orden, sin bloquear a otros chats.
 */
export class KeyedQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, number>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);

    const previous = this.tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);

    const decrement = (): void => {
      const remaining = (this.pending.get(key) ?? 1) - 1;
      if (remaining <= 0) {
        this.pending.delete(key);
        if (this.tails.get(key) === tail) this.tails.delete(key);
      } else {
        this.pending.set(key, remaining);
      }
    };

    const tail: Promise<void> = run.then(decrement, decrement);
    this.tails.set(key, tail);

    return run;
  }

  /** Numero de tareas encoladas o en curso para esa clave. */
  pendingFor(key: string): number {
    return this.pending.get(key) ?? 0;
  }

  get size(): number {
    let total = 0;
    for (const count of this.pending.values()) total += count;
    return total;
  }
}
