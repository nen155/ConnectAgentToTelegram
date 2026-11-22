import { agentProcessMatchers, ProcessRegistry } from '../src/core/processRegistry';
import { formatProcessList, isDelayQuestion } from '../src/telegram/bot';

const startedAt = Date.now() - 12 * 60 * 1000;

describe('ProcessRegistry', () => {
  it('registra, lista en orden de arranque y quita por pid', () => {
    const registry = new ProcessRegistry();
    registry.add({ pid: 20, agent: 'devin', label: 'Devin', prompt: 'segunda', startedAt: startedAt + 5000 });
    registry.add({ pid: 10, agent: 'devin', label: 'Devin', prompt: 'primera', startedAt });

    expect(registry.list().map((item) => item.pid)).toEqual([10, 20]);
    expect(registry.list()[0]?.source).toBe('bridge');

    registry.remove(10);
    expect(registry.list().map((item) => item.pid)).toEqual([20]);
    expect(registry.get(10)).toBeUndefined();
  });

  it('empareja por ruta el binario absoluto y por nombre el que esta en el PATH', () => {
    const matchers = agentProcessMatchers([
      'C:\\Users\\NeN\\AppData\\Local\\devin\\cli\\bin\\devin.exe',
      'opencode'
    ]);

    // Devin va por ruta: asi no se confunde con Devin.exe (la app de escritorio).
    expect(matchers.paths).toEqual(['c:\\users\\nen\\appdata\\local\\devin\\cli\\bin\\devin.exe']);
    expect(matchers.names).toContain('opencode');
    expect(matchers.names).toContain('opencode.exe');
    expect(matchers.names).not.toContain('devin.exe');
  });
});

describe('isDelayQuestion', () => {
  it('reconoce las preguntas por la lentitud', () => {
    expect(isDelayQuestion('¿por qué tarda tanto?')).toBe(true);
    expect(isDelayQuestion('por que tarda tanto')).toBe(true);
    expect(isDelayQuestion('esta tardando mucho')).toBe(true);
    expect(isDelayQuestion('qué está haciendo')).toBe(true);
  });

  it('no secuestra ordenes normales ni mensajes largos', () => {
    expect(isDelayQuestion('arregla el login')).toBe(false);
    expect(
      isDelayQuestion('revisa por que tarda tanto el arranque del servicio y documenta el resultado')
    ).toBe(false);
  });
});

describe('formatProcessList', () => {
  it('lista pid, agente y tiempo, y marca los procesos externos', () => {
    const text = formatProcessList(
      [
        { pid: 1234, agent: 'devin', label: 'Devin', prompt: 'arregla el login', startedAt, source: 'bridge' },
        {
          pid: 5678,
          agent: 'opencode',
          label: 'opencode',
          prompt: '',
          startedAt: startedAt + 10 * 60 * 1000,
          source: 'external',
          commandLine: 'opencode run "algo"'
        }
      ],
      Date.now()
    );

    expect(text).toContain('PID 1234');
    expect(text).toContain('12m');
    expect(text).toContain('arregla el login');
    expect(text).toContain('fuera del puente');
    expect(text).toContain('opencode run');
  });

  it('dice claramente cuando no hay nada en marcha', () => {
    expect(formatProcessList([], Date.now())).toContain('No hay ningun proceso');
  });
});
