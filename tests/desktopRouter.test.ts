import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopRouter } from '../src/devin/desktopRouter';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-router-'));

function routerWith(exec: jest.Mock): DesktopRouter {
  return new DesktopRouter({
    scriptPath: 'scripts/send-to-desktop.ps1',
    tmpDir,
    projectName: 'mi-proyecto',
    exec: exec as never
  });
}

describe('DesktopRouter', () => {
  it('considera enviada la orden cuando el script responde OK_ENVIADA', async () => {
    const exec = jest.fn(async () => ({ stdout: 'OK_ENVIADA\n', stderr: '', code: 0, timedOut: false }));
    const result = await routerWith(exec).send('arregla el bug');

    expect(result.sent).toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Project', 'mi-proyecto', '-PromptFile']),
      expect.any(Object)
    );
  });

  it('pasa la orden por archivo, no por linea de comandos', async () => {
    let written = '';
    const exec = jest.fn(async (_bin: string, args: string[]) => {
      const file = args[args.indexOf('-PromptFile') + 1] ?? '';
      written = fs.readFileSync(file, 'utf8');
      return { stdout: 'OK_ENVIADA', stderr: '', code: 0, timedOut: false };
    });

    await routerWith(exec).send('orden con "comillas" y saltos\nsegunda linea');
    expect(written).toContain('comillas');
  });

  it('informa del motivo cuando no hay ventana', async () => {
    const exec = jest.fn(async () => ({
      stdout: 'SIN_VENTANA: no hay ninguna ventana abierta\n',
      stderr: '',
      code: 2,
      timedOut: false
    }));

    const result = await routerWith(exec).send('hola');
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('SIN_VENTANA');
  });

  it('no se cuelga si el script falla al arrancar', async () => {
    const exec = jest.fn(async () => {
      throw new Error('powershell no encontrado');
    });

    const result = await routerWith(exec).send('hola');
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('powershell');
  });

  it('borra el archivo temporal de la orden', async () => {
    const exec = jest.fn(async (_bin: string, args: string[]) => {
      const file = args[args.indexOf('-PromptFile') + 1] ?? '';
      expect(fs.existsSync(file)).toBe(true);
      return { stdout: 'OK_ENVIADA', stderr: '', code: 0, timedOut: false };
    });

    await routerWith(exec).send('hola');
    expect(fs.readdirSync(tmpDir).filter((name) => name.startsWith('desktop-'))).toHaveLength(0);
  });
});
