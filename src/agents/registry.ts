import type { AppConfig } from '../config';
import type { AgentAdapter, AgentName } from './types';
import { createDevinAgent } from './devin';
import { createOpenCodeAgent } from './opencode';
import { createCodexAgent } from './codex';
import { createClaudeAgent } from './claude';
import { createOpenAiAgent } from './openai';

export const AGENT_NAMES: AgentName[] = ['devin', 'opencode', 'codex', 'claude', 'openai'];

const FACTORIES: Record<AgentName, (config: AppConfig) => AgentAdapter> = {
  devin: createDevinAgent,
  opencode: createOpenCodeAgent,
  codex: createCodexAgent,
  claude: createClaudeAgent,
  openai: createOpenAiAgent
};

/**
 * Construye el adaptador del agente configurado (`AGENT`). Anadir un agente nuevo es
 * escribir su carpeta en `src/agents/<nombre>/` y registrarlo aqui.
 */
export function createAgent(config: AppConfig): AgentAdapter {
  const factory = FACTORIES[config.agent.name];
  if (!factory) {
    throw new Error(`Agente desconocido: ${config.agent.name}. Valores: ${AGENT_NAMES.join(', ')}`);
  }
  return factory(config);
}
