import { MockDevinRunner, MockTranscriber, MOCK_REPLY, MOCK_TRANSCRIPT } from '../src/mocks';

describe('mocks', () => {
  it('el transcriber simulado devuelve el texto fijado', async () => {
    const transcriber = new MockTranscriber('texto de prueba');
    await expect(transcriber.transcribe()).resolves.toBe('texto de prueba');
  });

  it('el transcriber usa una frase por defecto', async () => {
    const transcriber = new MockTranscriber();
    await expect(transcriber.transcribe()).resolves.toBe(MOCK_TRANSCRIPT);
  });

  it('el runner simulado devuelve respuesta, sesion y duracion', async () => {
    const runner = new MockDevinRunner();
    const result = await runner.run({ prompt: 'hola', allowContinue: false, cwd: '.', timeoutMs: 1000 });

    expect(result.text).toContain(MOCK_REPLY);
    expect(result.text).toContain('hola');
    expect(result.sessionId).toBe('mock-session');
    expect(result.exitCode).toBe(0);
  });
});
