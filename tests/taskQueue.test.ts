import { KeyedQueue } from '../src/core/taskQueue';

describe('KeyedQueue', () => {
  it('ejecuta las tareas de una misma clave en orden FIFO', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];

    const first = queue.enqueue('chat', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push('primera');
    });
    const second = queue.enqueue('chat', async () => {
      order.push('segunda');
    });

    await Promise.all([first, second]);

    expect(order).toEqual(['primera', 'segunda']);
  });

  it('no bloquea claves distintas entre si', async () => {
    const queue = new KeyedQueue();
    const events: string[] = [];

    const slow = queue.enqueue('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      events.push('a');
    });
    const fast = queue.enqueue('b', async () => {
      events.push('b');
    });

    await fast;
    expect(events).toEqual(['b']);
    await slow;
  });

  it('sigue procesando la cola cuando una tarea falla', async () => {
    const queue = new KeyedQueue();
    const order: string[] = [];

    const failing = queue.enqueue('chat', async () => {
      throw new Error('boom');
    });
    const next = queue.enqueue('chat', async () => {
      order.push('siguiente');
    });

    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(order).toEqual(['siguiente']);
  });

  it('informa cuantas tareas hay pendientes por clave', async () => {
    const queue = new KeyedQueue();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const running = queue.enqueue('chat', () => gate);
    expect(queue.pendingFor('chat')).toBe(1);

    const waiting = queue.enqueue('chat', async () => undefined);
    expect(queue.pendingFor('chat')).toBe(2);
    expect(queue.size).toBe(2);

    release();
    await Promise.all([running, waiting]);

    expect(queue.pendingFor('chat')).toBe(0);
  });
});
