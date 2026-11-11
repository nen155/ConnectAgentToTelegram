import { clipForSpeech } from '../src/audio/tts';
import { normalizeTranscript } from '../src/audio/whisper';
import { splitMessage } from '../src/telegram/bot';

describe('clipForSpeech', () => {
  it('quita markdown, enlaces y emojis', () => {
    const text = '**Listo** 🎉 revisa [el PR](https://x.com/pr) y `npm test`';
    const spoken = clipForSpeech(text, 500);

    expect(spoken).not.toContain('**');
    expect(spoken).not.toContain('https://');
    expect(spoken).toContain('el PR');
    expect(spoken).toContain('npm test');
    expect(spoken).not.toMatch(/🎉/u);
  });

  it('omite los bloques de codigo', () => {
    const spoken = clipForSpeech('Cambios:\n```ts\nconst a = 1;\n```\nfin', 500);
    expect(spoken).toContain('bloque de codigo omitido');
    expect(spoken).not.toContain('const a');
  });

  it('recorta por frase cuando el texto es demasiado largo', () => {
    const spoken = clipForSpeech(`${'palabra '.repeat(200)}. final distinto`, 100);
    expect(spoken.length).toBeLessThanOrEqual(105);
    expect(spoken.endsWith('...')).toBe(true);
  });

  it('devuelve cadena vacia si solo hay codigo', () => {
    expect(clipForSpeech('```\nsolo codigo\n```', 100)).toContain('bloque de codigo omitido');
  });
});

describe('normalizeTranscript', () => {
  it('limpia marcas de tiempo y espacios duplicados', () => {
    expect(normalizeTranscript(' [00:00:01.000 --> 00:00:03.000]  hola   mundo \n')).toBe('hola mundo');
  });
});

describe('splitMessage', () => {
  it('no toca los mensajes cortos', () => {
    expect(splitMessage('hola')).toEqual(['hola']);
  });

  it('parte por lineas sin superar el limite', () => {
    const text = Array.from({ length: 50 }, (_, index) => `linea ${index}`).join('\n');
    const chunks = splitMessage(text, 60);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(60);
    expect(chunks.join('\n')).toBe(text);
  });

  it('parte lineas indivisibles mas largas que el limite', () => {
    const chunks = splitMessage('x'.repeat(25), 10);
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });
});
