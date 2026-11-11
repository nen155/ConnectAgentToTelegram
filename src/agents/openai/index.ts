import type { AppConfig } from '../../config';
import type { AgentAdapter, AgentCheck } from '../types';
import { OpenAiCli } from './cli';

/** Adaptador de la API de OpenAI: conversacion sin CLI, sin IDE y sin sesiones en disco. */
export function createOpenAiAgent(config: AppConfig): AgentAdapter {
  const settings = config.agents.openai;

  const check = async (): Promise<AgentCheck> => {
    const problems: string[] = [];
    const notes: string[] = [`OpenAI API: ${settings.baseUrl} (${settings.model})`];
    if (!settings.apiKey) {
      problems.push('Falta OPENAI_API_KEY para usar el agente openai.');
    }
    return { ok: problems.length === 0, problems, notes };
  };

  return {
    name: 'openai',
    label: config.agent.label,
    cli: new OpenAiCli({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      maxTokens: settings.maxTokens,
      temperature: settings.temperature,
      systemPrompt: settings.systemPrompt
    }),
    sessions: null,
    desktop: null,
    check
  };
}
