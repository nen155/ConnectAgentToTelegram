import { extractMessageText, summarizeMessage } from '../src/core/sessionDigest';

describe('extractMessageText', () => {
  it('lee content como texto', () => {
    expect(extractMessageText('{"role":"assistant","content":"hola"}')).toEqual({ role: 'assistant', text: 'hola' });
  });

  it('une content en formato de partes', () => {
    const raw = '{"role":"assistant","content":[{"text":"parte 1"},{"text":"parte 2"}]}';
    expect(extractMessageText(raw)).toEqual({ role: 'assistant', text: 'parte 1 parte 2' });
  });

  it('devuelve null si no es JSON', () => {
    expect(extractMessageText('no-json')).toBeNull();
  });

  it('devuelve null si no hay contenido utilizable', () => {
    expect(extractMessageText('{"role":"assistant"}')).toBeNull();
  });
});

describe('summarizeMessage', () => {
  it('deja intacto lo que cabe', () => {
    expect(summarizeMessage('  hola  ', 50)).toBe('hola');
  });

  it('conserva el final, que es donde esta la conclusion', () => {
    const text = `${'detalle intermedio. '.repeat(200)}\n\nConclusion: los tests pasan y el README quedo actualizado.`;
    const result = summarizeMessage(text, 120);

    expect(result).toContain('Conclusion: los tests pasan');
    expect(result).toContain('\n…\n');
    expect(result.length).toBeLessThanOrEqual(120);
  });

  it('conserva el principio como contexto', () => {
    const text = `Empece revisando el proyecto.\n${'relleno '.repeat(300)}\nTermine con todo en verde.`;
    const result = summarizeMessage(text, 120);

    expect(result.startsWith('Empece revisando el proyecto.')).toBe(true);
    expect(result).toContain('Termine con todo en verde.');
  });

  it('no corta una linea si puede empezar en un salto', () => {
    const text = `linea uno larga\nlinea dos\n${'x'.repeat(500)}\nultima linea`;
    const result = summarizeMessage(text, 60);

    expect(result.startsWith('linea uno larga\n…\n')).toBe(true);
    expect(result).toContain('ultima linea');
  });
});
