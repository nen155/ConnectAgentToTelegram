import { createLogger } from '../src/logger';
import {
  ExternalAgentWatcher,
  extractPrompt,
  formatExternalTask,
  type RawProcess
} from '../src/core/externalAgents';

const logger = createLogger({ level: 'error' });

function proc(pid: number, commandLine: string, parentPid = 1): RawProcess {
  return { pid, parentPid, commandLine, startedAt: Date.now() - 60_000 };
}

describe('extractPrompt', () => {
  it('saca la orden de un comando con separador', () => {
    const cmd = '"C:\\x\\devin.exe" --permission-mode dangerous --print -- "revisa el readme"';
    expect(extractPrompt(cmd)).toBe('revisa el readme');
  });

  it('deja el comando completo si no hay separador', () => {
    expect(extractPrompt('devin.exe')).toBe('devin.exe');
  });
});

describe('formatExternalTask', () => {
  it('incluye duracion y orden', () => {
    const text = formatExternalTask({
      id: 'ext-1',
      chatId: 'external',
      prompt: 'arregla el bug',
      state: 'done',
      queuedAt: 0,
      startedAt: 0,
      durationMs: 125_000,
      source: 'external'
    });

    expect(text).toContain('Tarea de Devin terminada');
    expect(text).toContain('2m 5s');
    expect(text).toContain('arregla el bug');
  });

  it('recorta ordenes muy largas', () => {
    const text = formatExternalTask({
      id: 'ext-1',
      chatId: 'external',
      prompt: 'x'.repeat(500),
      state: 'done',
      queuedAt: 0,
      startedAt: 0,
      durationMs: 1000,
      source: 'external'
    });

    expect(text.length).toBeLessThan(500);
    expect(text).toContain('...');
  });

  it('incluye el resumen de la sesion cuando esta disponible', () => {
    const text = formatExternalTask(
      {
        id: 'ext-1',
        chatId: 'external',
        prompt: 'arregla el login',
        state: 'done',
        queuedAt: 0,
        startedAt: 0,
        durationMs: 5000,
        source: 'external'
      },
      { title: 'Arreglar login', summary: 'Cambie auth.ts y anadi un test.' }
    );

    expect(text).toContain('Resumen de lo que hizo');
    expect(text).toContain('Cambie auth.ts');
  });

  it('avisa cuando no pudo leer el resumen', () => {
    const text = formatExternalTask({
      id: 'ext-1',
      chatId: 'external',
      prompt: 'arregla el login',
      state: 'done',
      queuedAt: 0,
      startedAt: 0,
      durationMs: 5000,
      source: 'external'
    });

    expect(text).toContain('No pude leer el resumen');
  });
});

describe('ExternalAgentWatcher', () => {
  it('detecta un agente, lo mantiene activo y avisa al desaparecer', async () => {
    const finished: string[] = [];
    const changes: number[] = [];
    let current: RawProcess[] = [proc(1234, 'devin.exe --print -- "ordena los archivos"')];

    const watcher = new ExternalAgentWatcher({
      listProcesses: async () => current,
      onFinished: (task) => finished.push(task.prompt),
      onChanged: () => changes.push(1),
      logger
    });

    await watcher.poll();
    expect(watcher.active()).toHaveLength(1);
    expect(watcher.active()[0]?.prompt).toBe('ordena los archivos');

    current = [];
    await watcher.poll();

    expect(watcher.active()).toHaveLength(0);
    expect(finished).toEqual(['ordena los archivos']);
    expect(watcher.recent()).toHaveLength(1);
    expect(watcher.recent()[0]?.state).toBe('done');
    expect(changes.length).toBe(2);
  });

  it('ignora los agentes hijos del propio puente', async () => {
    const watcher = new ExternalAgentWatcher({
      listProcesses: async () => [proc(999, 'devin.exe -p -- "orden del bot"', 4242)],
      onFinished: () => undefined,
      excludePid: 4242,
      logger
    });

    await watcher.poll();
    expect(watcher.active()).toHaveLength(0);
  });

  it('cuenta una sola tarea cuando el agente lanza un subproceso', async () => {
    const watcher = new ExternalAgentWatcher({
      listProcesses: async () => [
        proc(500, 'devin.exe --print -- "revisa el readme"', 1),
        proc(501, 'devin.exe --worker', 500)
      ],
      onFinished: () => undefined,
      logger
    });

    await watcher.poll();

    expect(watcher.active()).toHaveLength(1);
    expect(watcher.active()[0]?.prompt).toBe('revisa el readme');
  });

  it('no repite el aviso en sondeos sucesivos sin cambios', async () => {
    const finished: string[] = [];
    const watcher = new ExternalAgentWatcher({
      listProcesses: async () => [],
      onFinished: (task) => finished.push(task.id),
      logger
    });

    await watcher.poll();
    await watcher.poll();
    expect(finished).toHaveLength(0);
  });

  it('sobrevive si el listado de procesos falla', async () => {
    const watcher = new ExternalAgentWatcher({
      listProcesses: async () => {
        throw new Error('sin permisos');
      },
      onFinished: () => undefined,
      logger
    });

    await expect(watcher.poll()).resolves.toBeUndefined();
    expect(watcher.active()).toHaveLength(0);
  });

  it('conserva solo las ultimas tareas terminadas', async () => {
    let current: RawProcess[] = [];
    const watcher = new ExternalAgentWatcher({
      listProcesses: async () => current,
      onFinished: () => undefined,
      logger,
      maxRecent: 2
    });

    for (let index = 0; index < 4; index += 1) {
      current = [proc(100 + index, `devin.exe -p -- "tarea ${index}"`)];
      await watcher.poll();
      current = [];
      await watcher.poll();
    }

    expect(watcher.recent()).toHaveLength(2);
  });
});
