import {
  buildDevinArgs,
  cleanDevinOutput,
  DevinRunner,
  extractSessionId,
  extractSessionIdFromOutput,
  friendlyDevinError
} from '../src/devin/devinRunner';
import type { CommandExecutor } from '../src/devin/devinRunner';
import { devinEnv, DEVIN_ENV_STRIP } from '../src/devin/env';

const options = { permissionMode: 'dangerous', extraArgs: [] };

describe('buildDevinArgs', () => {
  it('usa --print con separador para proteger ordenes que empiezan por guion', () => {
    const args = buildDevinArgs({ prompt: '- arregla el bug', allowContinue: false }, options, 'export.json');

    expect(args).toContain('--print');
    expect(args.slice(args.indexOf('--print'), args.indexOf('--print') + 3)).toEqual(['--print', '--', '- arregla el bug']);
    expect(args).toContain('--respect-workspace-trust');
    expect(args).toContain('false');
  });

  it('coloca todos los flags antes del separador --', () => {
    const args = buildDevinArgs({ prompt: 'hola', allowContinue: false }, options, 'e.json');
    const separator = args.indexOf('--');

    expect(separator).toBeGreaterThan(-1);
    expect(args.slice(separator + 1)).toEqual(['hola']);

    const flags = args.slice(0, separator);
    expect(flags).toContain('--permission-mode');
    expect(flags).toContain('--respect-workspace-trust');
    expect(flags).toContain('--export');
    expect(flags).toContain('--print');
  });

  it('reanuda por id cuando hay sesion conocida', () => {
    const args = buildDevinArgs({ prompt: 'sigue', sessionId: 'brisk-otter', allowContinue: true }, options, 'e.json');
    expect(args.slice(0, 2)).toEqual(['--resume', 'brisk-otter']);
    expect(args).not.toContain('--continue');
  });

  it('cae a --continue solo si no hay id y ya hubo ejecuciones', () => {
    const args = buildDevinArgs({ prompt: 'sigue', allowContinue: true }, options, 'e.json');
    expect(args[0]).toBe('--continue');
  });

  it('no reanuda nada en una sesion nueva', () => {
    const args = buildDevinArgs({ prompt: 'hola', allowContinue: false }, options, 'e.json');
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('--resume');
  });

  it('anade modelo y argumentos extra al final', () => {
    const args = buildDevinArgs(
      { prompt: 'hola', allowContinue: false },
      { permissionMode: 'smart', model: 'opus', extraArgs: ['--verbose'] },
      'e.json'
    );
    expect(args).toContain('--model');
    expect(args).toContain('opus');
    expect(args).toContain('--verbose');
    expect(args).toContain('smart');
  });
});

describe('extractSessionId', () => {
  it('encuentra session_id en el nivel superior', () => {
    expect(extractSessionId({ session_id: 'brisk-otter' })).toBe('brisk-otter');
  });

  it('encuentra trajectory_id anidado en metadata', () => {
    expect(extractSessionId({ header: { metadata: { trajectory_id: 'abcd-1234' } } })).toBe('abcd-1234');
  });

  it('ignora valores demasiado cortos o que no son ids', () => {
    expect(extractSessionId({ session_id: 'ab' })).toBeUndefined();
    expect(extractSessionId({ session_id: 42 })).toBeUndefined();
    expect(extractSessionId('texto')).toBeUndefined();
  });

  it('extrae el id de la salida en texto como ultimo recurso', () => {
    expect(extractSessionIdFromOutput('Session: brisk-otter\n')).toBe('brisk-otter');
    expect(extractSessionIdFromOutput('nada relevante')).toBeUndefined();
  });
});

describe('cleanDevinOutput', () => {
  it('quita codigos ANSI y colapsa lineas en blanco', () => {
    const raw = '\u001B[32mHecho\u001B[0m\r\n\n\n\nfin\n';
    expect(cleanDevinOutput(raw)).toBe('Hecho\n\nfin');
  });
});

describe('friendlyDevinError', () => {
  it('traduce el error de sesion no iniciada', () => {
    expect(friendlyDevinError('Not logged in.', '')).toMatch(/devin auth login/);
  });

  it('traduce el limite de uso', () => {
    expect(friendlyDevinError('', 'usage limit reached')).toMatch(/limite de uso/);
  });

  it('devuelve null si no reconoce el error', () => {
    expect(friendlyDevinError('algo raro', '')).toBeNull();
  });
});

describe('DevinRunner.run', () => {
  const baseOptions = {
    bin: 'devin',
    permissionMode: 'dangerous',
    extraArgs: [],
    tmpDir: process.cwd()
  };

  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0, timedOut: false });

  it('falla rapido y sin lanzar la orden si no hay sesion iniciada', async () => {
    const exec = jest.fn<ReturnType<CommandExecutor>, Parameters<CommandExecutor>>(async () =>
      ok('Not logged in.\n')
    );
    const runner = new DevinRunner({ ...baseOptions, exec });

    await expect(
      runner.run({ prompt: 'hola', allowContinue: false, cwd: '.', timeoutMs: 1000 })
    ).rejects.toThrow(/devin auth login/);

    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1]).toEqual(['auth', 'status']);
  });

  it('ejecuta la orden y devuelve el texto limpio con su session id', async () => {
    const exec = jest
      .fn<ReturnType<CommandExecutor>, Parameters<CommandExecutor>>()
      .mockResolvedValueOnce(ok('Logged in as nen'))
      .mockResolvedValueOnce(ok('\u001B[32mHecho\u001B[0m\n\n\nfin'));

    const runner = new DevinRunner({ ...baseOptions, exec });
    const result = await runner.run({ prompt: 'arregla', allowContinue: false, cwd: 'C:\p', timeoutMs: 5000 });

    expect(result.text).toBe('Hecho\n\nfin');
    expect(result.exitCode).toBe(0);

    const runArgs = exec.mock.calls[1]?.[1] ?? [];
    expect(runArgs).toContain('--print');
    expect(exec.mock.calls[1]?.[2]).toMatchObject({ cwd: 'C:\p' });
  });

  it('no repite la comprobacion de sesion en ordenes seguidas', async () => {
    const exec = jest
      .fn<ReturnType<CommandExecutor>, Parameters<CommandExecutor>>()
      .mockResolvedValue(ok('Logged in as nen'));

    const runner = new DevinRunner({ ...baseOptions, exec });
    await runner.run({ prompt: 'uno', allowContinue: false, cwd: '.', timeoutMs: 5000 });
    await runner.run({ prompt: 'dos', allowContinue: false, cwd: '.', timeoutMs: 5000 });

    const authCalls = exec.mock.calls.filter(([, args]) => args[0] === 'auth');
    expect(authCalls).toHaveLength(1);
  });

  it('informa del timeout en lugar de devolver una respuesta vacia', async () => {
    const exec = jest
      .fn<ReturnType<CommandExecutor>, Parameters<CommandExecutor>>()
      .mockResolvedValueOnce(ok('Logged in as nen'))
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: -1, timedOut: true });

    const runner = new DevinRunner({ ...baseOptions, exec });

    await expect(
      runner.run({ prompt: 'largo', allowContinue: false, cwd: '.', timeoutMs: 60_000 })
    ).rejects.toThrow(/tiempo maximo/);
  });
});

describe('devinEnv', () => {
  it('quita ACP_BACKEND y conserva el resto del entorno', () => {
    const env = devinEnv({ ACP_BACKEND: 'windsurf', APPDATA: 'C:\\x', PATH: 'p' } as NodeJS.ProcessEnv);

    expect(env.ACP_BACKEND).toBeUndefined();
    expect(env.APPDATA).toBe('C:\\x');
    expect(env.PATH).toBe('p');
  });

  it('no muta el objeto original', () => {
    const base = { ACP_BACKEND: 'windsurf' } as NodeJS.ProcessEnv;
    devinEnv(base);
    expect(base.ACP_BACKEND).toBe('windsurf');
  });

  it('solo elimina ACP_BACKEND', () => {
    expect(DEVIN_ENV_STRIP).toEqual(['ACP_BACKEND']);
  });
});
