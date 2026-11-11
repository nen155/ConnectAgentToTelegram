const MAX_SUMMARY_CHARS = 900;

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

export function truncateSummary(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  const clean = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 3).trim()}...`;
}
