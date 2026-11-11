import { extractMessageText, truncateSummary } from '../src/core/sessionDigest';

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

describe('truncateSummary', () => {
  it('recorta y anade puntos suspensivos', () => {
    const result = truncateSummary('x'.repeat(1000), 50);
    expect(result).toHaveLength(50);
    expect(result.endsWith('...')).toBe(true);
  });

  it('deja intacto lo que cabe', () => {
    expect(truncateSummary('  hola  ', 50)).toBe('hola');
  });
});
