import { TaskRegistry } from '../src/core/taskRegistry';

describe('TaskRegistry', () => {
  it('crea la tarea en estado queued', () => {
    const registry = new TaskRegistry();
    const task = registry.create({ chatId: '1', prompt: 'hola' });

    expect(task.state).toBe('queued');
    expect(registry.active()).toHaveLength(1);
  });

  it('actualiza estado y metadatos sin perder campos', () => {
    const registry = new TaskRegistry();
    const task = registry.create({ chatId: '1', prompt: 'hola' });

    registry.update(task.id, { state: 'working', startedAt: 100 });
    const updated = registry.update(task.id, { state: 'done', durationMs: 500, exitCode: 0 });

    expect(updated).toMatchObject({ prompt: 'hola', chatId: '1', state: 'done', durationMs: 500, startedAt: 100 });
  });

  it('separa activas de recientes y ordena por tiempo', () => {
    const registry = new TaskRegistry();
    const first = registry.create({ chatId: '1', prompt: 'primera' });
    registry.update(first.id, { state: 'done', finishedAt: 200 });
    const second = registry.create({ chatId: '1', prompt: 'segunda' });
    registry.update(second.id, { state: 'done', finishedAt: 300 });
    const running = registry.create({ chatId: '1', prompt: 'en curso' });
    registry.update(running.id, { state: 'working' });

    const snapshot = registry.snapshot();

    expect(snapshot.active.map((task) => task.prompt)).toEqual(['en curso']);
    expect(snapshot.recent.map((task) => task.prompt)).toEqual(['segunda', 'primera']);
  });

  it('ignora actualizaciones de tareas inexistentes', () => {
    const registry = new TaskRegistry();
    expect(registry.update('no-existe', { state: 'done' })).toBeUndefined();
  });

  it('no crece sin limite: descarta las terminadas mas antiguas', () => {
    const registry = new TaskRegistry();
    for (let index = 0; index < 30; index += 1) {
      const task = registry.create({ chatId: '1', prompt: `tarea ${index}` });
      registry.update(task.id, { state: 'done', finishedAt: index });
    }

    const recent = registry.recent(50);
    expect(recent.length).toBeLessThanOrEqual(20);
    expect(recent[0]?.prompt).toBe('tarea 29');
  });
});
