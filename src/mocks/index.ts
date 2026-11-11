import type { Transcriber } from '../audio/whisper';
import type { DevinRunRequest, DevinRunResult } from '../devin/devinRunner';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const MOCK_TRANSCRIPT =
  'Revisa el README del proyecto y dime cuantas secciones tiene, sin modificar archivos.';

export const MOCK_REPLY =
  'Respuesta simulada: el README tiene 9 secciones y no he tocado ningun archivo.\n' +
  'Este texto lo genera un mock local, no un modelo.';

/**
 * Transcriber falso para MOCK_MODE y para la demo: no descarga ni ejecuta whisper.
 */
export class MockTranscriber implements Transcriber {
  readonly name = 'mock';

  constructor(private readonly text: string = MOCK_TRANSCRIPT) {}

  async transcribe(): Promise<string> {
    await delay(600);
    return this.text;
  }
}

/**
 * Sustituto de DevinRunner que responde en ~2 s sin llamar a ningun modelo.
 * Sirve para probar el puente (Telegram, cola, TTS, bandeja) sin cuenta de Devin.
 */
export class MockDevinRunner {
  constructor(private readonly reply: string = MOCK_REPLY) {}

  async run(request: DevinRunRequest): Promise<DevinRunResult> {
    await delay(2000);
    return {
      text: `${this.reply}\n\nOrden recibida: "${request.prompt}"`,
      sessionId: 'mock-session',
      durationMs: 2000,
      exitCode: 0
    };
  }
}
