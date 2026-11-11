import type { DesktopWindow } from './types';

const STOP_WORDS = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'para',
  'con',
  'por',
  'que',
  'proyecto',
  'devin',
  'the',
  'and'
]);

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export interface ProjectMatch {
  window: DesktopWindow;
  /** Tokens del proyecto encontrados en la orden. */
  hits: string[];
  score: number;
}

/**
 * Empareja el proyecto mencionado en la orden con una ventana abierta.
 * Se comparan palabras (sin acentos ni mayusculas) y se exige al menos una palabra
 * distintiva de 4+ caracteres para evitar falsos positivos ("web", "app"...).
 */
export function matchProject(orderText: string, windows: DesktopWindow[]): ProjectMatch | null {
  const orderTokens = new Set(tokenize(orderText));
  if (orderTokens.size === 0) return null;

  let best: ProjectMatch | null = null;

  for (const window of windows) {
    const projectTokens = tokenize(window.project);
    const hits = projectTokens.filter((token) => orderTokens.has(token));
    if (hits.length === 0) continue;
    if (!hits.some((token) => token.length >= 4)) continue;

    const score = hits.reduce((total, token) => total + token.length, 0);
    if (!best || score > best.score || (score === best.score && hits.length > best.hits.length)) {
      best = { window, hits, score };
    }
  }

  return best;
}
