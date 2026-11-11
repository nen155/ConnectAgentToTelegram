import fs from 'node:fs/promises';
import path from 'node:path';

export interface ChatSession {
  sessionId?: string;
  cwd: string;
  runs: number;
  lastRunAt: number;
  lastPrompt?: string;
}

type SessionsFile = Record<string, ChatSession>;

/**
 * Persistencia minima (JSON) del hilo de conversacion por chat de Telegram.
 * Escritura atomica: escribe a .tmp y renombra, para no corromper el archivo si el proceso muere.
 */
export class SessionStore {
  private sessions: SessionsFile = {};
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.sessions = parsed && typeof parsed === 'object' ? (parsed as SessionsFile) : {};
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
      this.sessions = {};
    }
  }

  get(chatId: string): ChatSession | undefined {
    return this.sessions[chatId];
  }

  list(): Array<[string, ChatSession]> {
    return Object.entries(this.sessions);
  }

  async record(chatId: string, patch: Partial<ChatSession> & { cwd: string }): Promise<ChatSession> {
    const previous = this.sessions[chatId];
    const next: ChatSession = {
      cwd: patch.cwd,
      runs: (previous?.runs ?? 0) + 1,
      lastRunAt: Date.now(),
      sessionId: patch.sessionId ?? previous?.sessionId,
      lastPrompt: patch.lastPrompt ?? previous?.lastPrompt
    };
    this.sessions[chatId] = next;
    await this.persist();
    return next;
  }

  async reset(chatId: string): Promise<void> {
    delete this.sessions[chatId];
    await this.persist();
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(this.sessions, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      await fs.writeFile(tmp, snapshot, 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }
}
