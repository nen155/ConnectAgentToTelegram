const MAX_SUMMARY_CHARS = 900;
const HEAD_RATIO = 0.3;

/** Saca el texto de un `chat_message` (content puede ser string o lista de partes). */
export function extractMessageText(chatMessage: string): { role: string; text: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chatMessage);
  } catch {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  const role = typeof record.role === 'string' ? record.role : '';
  const content = record.content;

  if (typeof content === 'string') return { role, text: content };
  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        const item = part as Record<string, unknown>;
        return typeof item.text === 'string' ? item.text : '';
      })
      .join(' ')
      .trim();
    return { role, text };
  }
  return null;
}

/**
 * Resume un mensaje largo conservando el principio (contexto) y, sobre todo, el final:
 * la conclusion de lo que hizo el modelo suele estar en las ultimas lineas. El hueco
 * se marca con `…` para que se note que hay contenido omitido.
 */
export function summarizeMessage(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= maxChars) return clean;

  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = maxChars - headChars - 3; // hueco: "\n…\n"

  const headSlice = clean.slice(0, headChars);
  const headBreak = headSlice.lastIndexOf('\n');
  const head = (headBreak > headChars * 0.5 ? headSlice.slice(0, headBreak) : headSlice).trimEnd();

  const tailSlice = clean.slice(-tailChars);
  const tailBreak = tailSlice.indexOf('\n');
  const tail = (tailBreak >= 0 && tailBreak < tailChars * 0.3 ? tailSlice.slice(tailBreak + 1) : tailSlice).trimStart();

  return `${head}\n…\n${tail}`;
}
