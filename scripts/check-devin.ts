/**
 * Ejecuta una orden de prueba por el mismo runner que usa el bot.
 * Uso: npm run check:devin            (orden por defecto)
 *      npm run check:devin -- "otra orden"
 */
import { loadConfig } from '../src/config';
import { DevinRunner } from '../src/devin/devinRunner';

const DEFAULT_PROMPT = 'Responde en una sola frase, sin tocar archivos: confirma que estas operativo y di en que carpeta trabajas.';

async function main(): Promise<void> {
  const config = loadConfig();
  const prompt = process.argv.slice(2).join(' ').trim() || DEFAULT_PROMPT;

  const runner = new DevinRunner({
    bin: config.devin.bin,
    permissionMode: config.devin.permissionMode,
    model: config.devin.model,
    extraArgs: config.devin.extraArgs,
    tmpDir: config.paths.tmp
  });

  console.log(`Orden: ${prompt}`);
  console.log(`Carpeta: ${config.devin.workdir}`);
  console.log(`Permisos: ${config.devin.permissionMode}`);
  console.log('');

  const started = Date.now();
  try {
    const result = await runner.run({
      prompt,
      allowContinue: false,
      cwd: config.devin.workdir,
      timeoutMs: config.devin.timeoutMs
    });

    console.log(`--- respuesta (${Math.round((Date.now() - started) / 1000)} s) ---`);
    console.log(result.text || '(sin texto)');
    console.log('');
    console.log(`session id detectado: ${result.sessionId ?? 'no detectado (se usara --continue)'}`);
    console.log(`codigo de salida: ${result.exitCode}`);
  } catch (error) {
    console.error(`Fallo: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

void main();
