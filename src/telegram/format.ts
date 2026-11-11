/**
 * Convierte el Markdown que produce el agente al subconjunto que Telegram entiende
 * (HTML, parse_mode HTML). Telegram no renderiza Markdown tal cual: los `**`, los
 * backticks y las cabeceras llegan como caracteres literales y el resumen queda
 * ilegible.
 *
 * Soporta lo que devuelven los resumenes de Devin: negrita, cursiva, tachado,
 * codigo inline, bloques de codigo, encabezados, enlaces, tablas (en bloque
 * monoespaciado, Telegram no tiene tablas), citas y lineas divisorias.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;'
};

const NUL = String.fromCharCode(0);
const BLOCK = `${NUL}BLOCK${NUL}`;
const TABLE = `${NUL}TABLE${NUL}`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => ESCAPES[char] ?? char);
}

export function markdownToTelegramHtml(markdown: string): string {
  if (!markdown) return '';

  const blocks: string[] = [];
  const tables: string[] = [];

  // Los bloques de codigo se extraen primero para que su contenido no se
  // interprete como markdown. Un cierre ausente significa bloque hasta el final:
  // los mensajes pueden partirse por el limite de Telegram a mitad de un fence.
  let text = markdown.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)(?:```|$)/g, (_match, code: string) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n+$/, ''))}</pre>`);
    return `${BLOCK}${blocks.length - 1}${NUL}`;
  });

  // Tablas: lineas consecutivas con |. Se quita la fila separadora |---|.
  text = text.replace(
    /(^|\n)((?:[ \t]*\|[^\n]*\|[ \t]*\n?)+)/g,
    (_match, prefix: string, block: string) => {
      const rows = block
        .replace(/\n+$/, '')
        .split('\n')
        .filter((line) => !/^\s*\|[\s:|-]+\|\s*$/.test(line));
      tables.push(`<pre>${escapeHtml(rows.join('\n'))}</pre>`);
      return `${prefix}${TABLE}${tables.length - 1}${NUL}`;
    }
  );

  text = escapeHtml(text);

  // Codigo en linea (despues de escapar: el contenido ya es seguro).
  text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Enlaces [texto](url).
  text = text.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2">$1</a>'
  );

  // Cabeceras (#, ##...) -> negrita.
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Negrita **texto** (antes que la cursiva para no partirla).
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  text = text.replace(/__([^_\n]+)__/g, '<b>$1</b>');

  // Cursiva *texto* / _texto_. Borde de palabra para no romper identificadores
  // tipo SMACKER_X ni operaciones tipo 2 * 3.
  text = text.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<i>$2</i>');
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');

  // Tachado.
  text = text.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  // Citas: lineas consecutivas con "> " (ya escapado como &gt;).
  text = text.replace(
    /(^|\n)((?:&gt; ?[^\n]*\n?)+)/g,
    (_match, prefix: string, block: string) => {
      const inner = block
        .replace(/\n+$/, '')
        .split('\n')
        .map((line) => line.replace(/^&gt; ?/, ''))
        .join('\n');
      return `${prefix}<blockquote>${inner}</blockquote>`;
    }
  );

  // Lineas divisorias.
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '⸻');

  text = text.replace(new RegExp(`${TABLE}(\\d+)${NUL}`, 'g'), (_match, index: string) => {
    return tables[Number(index)] ?? '';
  });
  text = text.replace(new RegExp(`${BLOCK}(\\d+)${NUL}`, 'g'), (_match, index: string) => {
    return blocks[Number(index)] ?? '';
  });

  return text;
}
