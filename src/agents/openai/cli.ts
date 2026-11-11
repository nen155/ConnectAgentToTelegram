import { randomUUID } from 'node:crypto';
import type { AgentCli, AgentRunRequest, AgentRunResult } from '../types';

export interface OpenAiCliOptions {
  apiKey?: string;
  /** Base compatible con OpenAI (`/chat/completions`). Vale tambien para servidores locales. */
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  /** Instruccion de sistema que se antepone a cada conversacion. */
  systemPrompt?: string;
  /** Mensajes que se conservan por sesion (usuario + asistente). */
  maxHistory?: number;
  /** Inyectable en pruebas. */
  fetchImpl?: typeof fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Adaptador para la API de OpenAI (o cualquier endpoint compatible: LM Studio, Ollama,
 * OpenRouter...). No tiene CLI ni IDE: es una conversacion sin acceso al repositorio, y
 * el historial vive en memoria, asi que se pierde al reiniciar el puente.
 */
export class OpenAiCli implements AgentCli {
  private readonly history = new Map<string, ChatMessage[]>();
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCliOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    if (!this.options.apiKey) {
      throw new Error('Falta OPENAI_API_KEY para usar el agente openai.');
    }

    const startedAt = Date.now();
    const sessionId = request.sessionId ?? `openai-${randomUUID()}`;
    const previous = this.history.get(sessionId) ?? [];

    const messages: ChatMessage[] = [
      ...(this.options.systemPrompt ? [{ role: 'system' as const, content: this.options.systemPrompt }] : []),
      ...previous,
      { role: 'user', content: request.prompt }
    ];

    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        max_tokens: this.options.maxTokens,
        temperature: this.options.temperature
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`OpenAI respondio ${response.status}: ${detail.slice(0, 300) || 'sin detalle'}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new Error('OpenAI no devolvio texto.');

    const limit = this.options.maxHistory ?? 20;
    const next = [...previous, { role: 'user' as const, content: request.prompt }, { role: 'assistant' as const, content: text }];
    this.history.set(sessionId, next.slice(-limit));

    return { text, sessionId, durationMs: Date.now() - startedAt, exitCode: 0 };
  }
}
