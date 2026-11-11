/**
 * Ejecuta una orden de prueba por el mismo adaptador que usa el bot, con el agente
 * configurado en AGENT (devin, opencode, codex, claude u openai).
 * Uso: npm run check:agent            (orden por defecto)
 *      npm run check:agent -- "otra orden"
 */
import { loadConfig, describeAgent } from '../src/config';
import { createAgent } from '../src/agents/registry';

const DEFAULT_PROMPT =
  'Responde en una sola frase, sin tocar archivos: confirma que estas operativo y di en que carpeta trabajas.';

async function main(): Promise<void> {
  const config = loadConfig();
  const agent = createAgent(config);
  const prompt = process.argv.slice(2).join(' ').trim() || DEFAULT_PROMPT;

  console.log(`Agente: ${agent.label} (${agent.name}, ${describeAgent(config)})`);
  console.log(`Orden: ${prompt}`);
  console.log(`Carpeta: ${config.agent.workdir}`);
  console.log('');

  const started = Date.now();
  try {
    const result = await agent.cli.run({
      prompt,
      allowContinue: false,
      cwd: config.agent.workdir,
      timeoutMs: config.agent.timeoutMs
    });

    console.log(`--- respuesta (${Math.round((Date.now() - started) / 1000)} s) ---`);
    console.log(result.text || '(sin texto)');
    console.log('');
    console.log(`session id detectado: ${result.sessionId ?? 'no detectado (se continuara la ultima)'}`);
    console.log(`codigo de salida: ${result.exitCode}`);
  } catch (error) {
    console.error(`Fallo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
