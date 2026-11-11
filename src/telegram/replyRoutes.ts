import fs from 'node:fs/promises';
import path from 'node:path';

export interface ReplyRoute {
  /** Proyecto (ventana del IDE) al que pertenece el mensaje. */
  project?: string;
  /** Sesion de Devin asociada, si se conocia. */
  sessionId?: string;
  createdAt: number;
}

const MAX_ROUTES = 300;

/**
 * Relaciona cada mensaje que envia el bot con el proyecto del que habla, para que
 * responder a ese mensaje (con texto o audio) enrute al proyecto sin inferirlo del texto.
 */
export class ReplyRouteStore {
  private routes = new Map<number, ReplyRoute>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, ReplyRoute>;
      for (const [key, value] of Object.entries(parsed)) {
        const messageId = Number(key);
        if (Number.isInteger(messageId) && value && typeof value.createdAt === 'number') {
          this.routes.set(messageId, value);
        }
      }
    } catch {
      this.routes = new Map();
    }
  }

  remember(messageId: number, route: Omit<ReplyRoute, 'createdAt'>): void {
    if (!Number.isInteger(messageId)) return;
    this.routes.set(messageId, { ...route, createdAt: Date.now() });
    this.prune();
    void this.persist();
  }

  resolve(messageId: number | undefined): ReplyRoute | undefined {
    if (!messageId) return undefined;
    return this.routes.get(messageId);
  }

  get size(): number {
    return this.routes.size;
  }

  private prune(): void {
    if (this.routes.size <= MAX_ROUTES) return;
    const ordered = [...this.routes.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    for (const [key] of ordered.slice(0, this.routes.size - MAX_ROUTES)) {
      this.routes.delete(key);
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(Object.fromEntries(this.routes));
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
