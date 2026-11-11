import { markdownToTelegramHtml } from '../src/telegram/format';

describe('markdownToTelegramHtml', () => {
  it('convierte negrita y encabezados', () => {
    const html = markdownToTelegramHtml('## Titulo\n**Listo** el cambio');
    expect(html).toBe('<b>Titulo</b>\n<b>Listo</b> el cambio');
  });

  it('convierte cursiva sin romper identificadores con guion bajo', () => {
    const html = markdownToTelegramHtml('usa *SMACKER_X* y SMACKER_X / SMACKER_Y, mas _otra_ cosa');
    expect(html).toContain('<i>SMACKER_X</i>');
    expect(html).toContain('SMACKER_X / SMACKER_Y');
    expect(html).toContain('<i>otra</i>');
  });

  it('convierte codigo inline y bloques de codigo', () => {
    const html = markdownToTelegramHtml('ejecuta `npm test` y:\n```bash\nnpm run build <out>\n```');
    expect(html).toContain('<code>npm test</code>');
    expect(html).toContain('<pre>npm run build &lt;out&gt;</pre>');
  });

  it('un bloque de codigo sin cerrar llega hasta el final', () => {
    const html = markdownToTelegramHtml('texto\n```\nsin cierre **no bold**');
    expect(html).toContain('<pre>sin cierre **no bold**</pre>');
  });

  it('convierte enlaces a etiquetas a', () => {
    const html = markdownToTelegramHtml('mira [el repo](https://github.com/x/y)');
    expect(html).toBe('mira <a href="https://github.com/x/y">el repo</a>');
  });

  it('escapa los caracteres reservados de HTML', () => {
    const html = markdownToTelegramHtml('a < b & c > d');
    expect(html).toBe('a &lt; b &amp; c &gt; d');
  });

  it('pasa tablas a bloque monoespaciado y quita el separador', () => {
    const md = '| Pieza | Nota |\n|---|---|\n| ffmpeg | libopus |';
    const html = markdownToTelegramHtml(md);
    expect(html).toContain('<pre>| Pieza | Nota |\n| ffmpeg | libopus |</pre>');
    expect(html).not.toContain('---');
  });

  it('convierte tachado y citas', () => {
    const html = markdownToTelegramHtml('~~viejo~~\n> cita uno\n> cita dos');
    expect(html).toContain('<s>viejo</s>');
    expect(html).toContain('<blockquote>cita uno\ncita dos</blockquote>');
  });

  it('las lineas divisorias no se comen texto', () => {
    const html = markdownToTelegramHtml('arriba\n---\nabajo');
    expect(html).toContain('arriba');
    expect(html).toContain('abajo');
    expect(html).not.toContain('---');
  });

  it('el contenido dentro de <pre> no se interpreta como markdown', () => {
    const html = markdownToTelegramHtml('```\n**no** `bold`\n```');
    expect(html).toBe('<pre>**no** `bold`</pre>');
  });
});
