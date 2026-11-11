import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppConfig } from '../src/config';
import { buildOpenCodeArgs, OpenCodeCli } from '../src/agents/opencode/cli';
import { readOpenCodeSessions } from '../src/agents/opencode/sessions';
import { buildCodexArgs } from '../src/agents/codex/cli';
import { readCodexSessions } from '../src/agents/codex/sessions';
import { buildClaudeArgs, parseClaudeOutput } from '../src/agents/claude/cli';
import { readClaudeSessions } from '../src/agents/claude/sessions';
import { OpenAiCli } from '../src/agents/openai/cli';
import { createAgent } from '../src/agents/registry';
import { TerminalDesktop } from '../src/agents/terminal/desktop';
import type { AgentRunRequest } from '../src/agents/types';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeConfig(overrides: Partial<AppConfig['agent']> = {}): AppConfig {
  const dir = tmpDir('agent-config-');
  return {
    telegram: { token: 't', allowedUserIds: [1] },
    agent: {
      name: 'devin',
      label: 'Devin',
      workdir: dir,
      projectName: 'proyecto',
      timeoutMs: 1000,
      continuity: 'auto',
      route: 'auto',
      ...overrides
    },
    agents: {
      devin: {
        bin: 'devin',
        permissionMode: 'dangerous',
        extraArgs: [],
        sessionsDb: path.join(dir, 'devin.db'),
        windowSuffix: ' - Devin',
        scripts: { desktop: 'd.ps1', terminal: 't.ps1' }
      },
      opencode: {
        bin: 'opencode',
        skipPermissions: true,
        extraArgs: [],
        sessionsDb: path.join(dir, 'opencode.db'),
        windowSuffix: ' - Devin',
        terminalPattern: 'opencode',
        scripts: { desktop: 'd.ps1', terminal: 't.ps1' }
      },
      codex: {
        bin: 'codex',
        fullAuto: true,
        skipGitRepoCheck: true,
        extraArgs: [],
        sessionsDir: path.join(dir, 'codex'),
        windowSuffix: ' - Devin',
        terminalPattern: 'codex',
        scripts: { desktop: 'd.ps1', terminal: 't.ps1' }
      },
      claude: {
        bin: 'claude',
        permissionMode: 'bypassPermissions',
        extraArgs: [],
        projectsDir: path.join(dir, 'claude'),
        windowSuffix: ' - Devin',
        terminalPattern: 'claude',
        scripts: { desktop: 'd.ps1', terminal: 't.ps1' }
      },
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-test' }
    },
    whisper: { bin: 'w', model: 'm', language: 'es', threads: 1, timeoutMs: 1000 },
    tts: { enabled: false, rate: 0, maxChars: 500 },
    ffmpegBin: 'ffmpeg',
    paths: {
      data: dir,
      tmp: dir,
      sessionsFile: path.join(dir, 'sessions.json'),
      logFile: path.join(dir, 'bridge.log'),
      ttsScript: 'tts.ps1',
      statusFile: path.join(dir, 'status.json'),
      replyRoutesFile: path.join(dir, 'reply-routes.json'),
      sendToDesktopScript: 'd.ps1',
      sendToTerminalScript: 't.ps1'
    },
    logLevel: 'error',
    summaryLanguage: '',
    mockMode: false
  };
}

const request: AgentRunRequest = {
  prompt: 'arregla el login',
  allowContinue: false,
  cwd: 'C:\\repo',
  timeoutMs: 1000
};

describe('OpenCode', () => {
  it('construye los argumentos con sesion, modelo y permisos', () => {
    const args = buildOpenCodeArgs(
      { ...request, sessionId: 'ses_123' },
      { model: 'opencode/big-pickle', agent: 'build', skipPermissions: true, extraArgs: [] }
    );

    expect(args[0]).toBe('run');
    expect(args).toEqual(expect.arrayContaining(['--session', 'ses_123', '--model', 'opencode/big-pickle', '--agent', 'build', '--dangerously-skip-permissions']));
    expect(args[args.length - 2]).toBe('--');
    expect(args[args.length - 1]).toBe('arregla el login');
  });

  it('usa --continue cuando no hay id y ya se ejecuto algo', () => {
    const args = buildOpenCodeArgs(
      { ...request, allowContinue: true },
      { skipPermissions: false, extraArgs: [] }
    );
    expect(args).toContain('--continue');
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('lee sesiones y el ultimo texto del asistente de su base', () => {
    const file = path.join(tmpDir('opencode-db-'), 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);
    `);
    const now = Date.now();
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_1', null, 'Arreglar login', 'C:\\repo', now);
    db.prepare('INSERT INTO message VALUES (?,?,?,?)').run('msg_1', 'ses_1', now, JSON.stringify({ role: 'assistant' }));
    db.prepare('INSERT INTO part VALUES (?,?,?,?,?)').run(
      'prt_1',
      'msg_1',
      'ses_1',
      now,
      JSON.stringify({ type: 'text', text: 'Hecho: arreglado el login.' })
    );
    db.close();

    const sessions = readOpenCodeSessions(file, { withinMs: 60 * 60 * 1000 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('ses_1');
    expect(sessions[0]?.cwd).toBe('C:\\repo');
    expect(sessions[0]?.lastText).toBe('Hecho: arreglado el login.');
    expect(sessions[0]?.state).toBe('working');
  });

  it('traduce el aviso de version antigua que OpenCode imprime en stdout', async () => {
    const exec = jest.fn(async () => ({
      stdout: 'Error: OpenCode 1.18.0 or newer is required to use the free tier\n',
      stderr: '',
      code: 0,
      timedOut: false
    }));
    const cli = new OpenCodeCli({ bin: 'opencode', skipPermissions: true, extraArgs: [], exec: exec as never });

    await expect(cli.run(request)).rejects.toThrow(/version mas nueva/);
  });

  it('recupera el id de sesion de la base si el CLI no lo imprime', async () => {    const file = path.join(tmpDir('opencode-cli-'), 'opencode.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, directory TEXT, time_updated INTEGER);`);
    db.prepare('INSERT INTO session VALUES (?,?,?,?,?)').run('ses_nueva', null, 'x', 'C:\\repo', Date.now());
    db.close();

    const exec = jest.fn(async () => ({ stdout: 'listo\n', stderr: '', code: 0, timedOut: false }));
    const cli = new OpenCodeCli({
      bin: 'opencode',
      skipPermissions: true,
      extraArgs: [],
      sessionsDb: file,
      exec: exec as never
    });

    const result = await cli.run(request);
    expect(result.text).toBe('listo');
    expect(result.sessionId).toBe('ses_nueva');
  });
});

describe('Codex', () => {
  it('coloca los flags entre exec y resume', () => {
    const args = buildCodexArgs(
      { ...request, sessionId: 'abc-123' },
      { model: 'gpt-5-codex', fullAuto: true, skipGitRepoCheck: true, extraArgs: [] }
    );

    expect(args.slice(0, 5)).toEqual(['exec', '--model', 'gpt-5-codex', '--full-auto', '--skip-git-repo-check']);
    expect(args).toEqual(expect.arrayContaining(['resume', 'abc-123']));
    expect(args[args.length - 1]).toBe('arregla el login');
  });

  it('usa resume --last para continuar sin id', () => {
    const args = buildCodexArgs(
      { ...request, allowContinue: true },
      { fullAuto: false, skipGitRepoCheck: false, extraArgs: [] }
    );
    expect(args).toEqual(expect.arrayContaining(['resume', '--last']));
  });

  it('lee el id, la carpeta y el ultimo mensaje de los rollouts', () => {
    const dir = tmpDir('codex-');
    const file = path.join(dir, '2026', '01', '01', 'rollout-1.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1', cwd: 'C:\\repo' } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hola' }] } }),
        JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Listo: login arreglado.' }] } })
      ].join('\n')
    );

    const sessions = readCodexSessions(dir, { withinMs: 60 * 60 * 1000 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('thread-1');
    expect(sessions[0]?.cwd).toBe('C:\\repo');
    expect(sessions[0]?.lastText).toBe('Listo: login arreglado.');
  });
});

describe('Claude Code', () => {
  it('construye los argumentos de modo headless', () => {
    const args = buildClaudeArgs(
      { ...request, sessionId: 'uuid-1' },
      { model: 'claude-sonnet-4-6', permissionMode: 'acceptEdits', extraArgs: [] }
    );

    expect(args.slice(0, 4)).toEqual(['-p', '--output-format', 'json', '--resume']);
    expect(args).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
    expect(args[args.length - 1]).toBe('arregla el login');
  });

  it('extrae texto y session id del JSON', () => {
    const parsed = parseClaudeOutput(
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Hecho.', session_id: 'uuid-1', is_error: false })
    );
    expect(parsed).toEqual({ text: 'Hecho.', sessionId: 'uuid-1', isError: false });
  });

  it('usa la salida tal cual si no es JSON', () => {
    expect(parseClaudeOutput('texto plano')).toEqual({ text: 'texto plano', isError: false });
  });

  it('lee el ultimo mensaje del asistente de las transcripciones', () => {
    const dir = tmpDir('claude-');
    const projectDir = path.join(dir, 'C--repo');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'ses-1.jsonl'),
      [
        JSON.stringify({ type: 'user', sessionId: 'ses-1', cwd: 'C:\\repo', message: { role: 'user', content: 'hola' } }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'ses-1',
          cwd: 'C:\\repo',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Listo: login arreglado.' }] }
        })
      ].join('\n')
    );

    const sessions = readClaudeSessions(dir, { withinMs: 60 * 60 * 1000 });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('ses-1');
    expect(sessions[0]?.lastText).toBe('Listo: login arreglado.');
  });
});

describe('OpenAI API', () => {
  it('llama a chat/completions y conserva el hilo', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Hola.' } }] })
    }));
    const cli = new OpenAiCli({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1/',
      model: 'gpt-4o-mini',
      fetchImpl: fetchImpl as never
    });

    const first = await cli.run(request);
    expect(first.text).toBe('Hola.');
    expect(first.sessionId).toMatch(/^openai-/);

    const second = await cli.run({ ...request, prompt: 'y ahora?', sessionId: first.sessionId });
    expect(second.sessionId).toBe(first.sessionId);

    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('falla con un mensaje claro sin API key', async () => {
    const cli = new OpenAiCli({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' });
    await expect(cli.run(request)).rejects.toThrow('OPENAI_API_KEY');
  });
});

describe('TerminalDesktop', () => {
  const options = {
    scriptPath: 'scripts/send-to-terminal.ps1',
    tmpDir: tmpDir('terminal-'),
    projectName: 'proyecto',
    windowSuffix: ' - Devin',
    expect: 'opencode'
  };

  it('pasa el sufijo de ventana y el patron del terminal', async () => {
    const exec = jest.fn(async () => ({ stdout: 'OK_ENVIADA\n', stderr: '', code: 0, timedOut: false }));
    const desktop = new TerminalDesktop({ ...options, exec: exec as never });

    const result = await desktop.send('hola', 'MilioLab');

    expect(result).toEqual({ sent: true, project: 'MilioLab' });
    expect(exec).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-Project', 'MilioLab', '-WindowSuffix', ' - Devin', '-Expect', 'opencode']),
      expect.any(Object)
    );
  });

  it('informa si el terminal no coincide con el agente', async () => {
    const exec = jest.fn(async () => ({
      stdout: "TERMINAL_NO_COINCIDE: no hay terminal con 'opencode' en la ventana de 'MilioLab'\n",
      stderr: '',
      code: 11,
      timedOut: false
    }));
    const desktop = new TerminalDesktop({ ...options, exec: exec as never });

    const result = await desktop.send('hola');
    expect(result.sent).toBe(false);
    expect(result.reason).toContain('TERMINAL_NO_COINCIDE');
  });
});

describe('registry', () => {  it('devuelve el adaptador del agente configurado', () => {
    expect(createAgent(makeConfig({ name: 'devin', label: 'Devin' })).name).toBe('devin');
    expect(createAgent(makeConfig({ name: 'opencode', label: 'OpenCode' })).name).toBe('opencode');
    expect(createAgent(makeConfig({ name: 'codex', label: 'Codex' })).name).toBe('codex');
    expect(createAgent(makeConfig({ name: 'claude', label: 'Claude Code' })).name).toBe('claude');
    expect(createAgent(makeConfig({ name: 'openai', label: 'OpenAI' })).name).toBe('openai');
  });

  it('openai no tiene sesiones ni escritorio; el resto si', () => {
    const openai = createAgent(makeConfig({ name: 'openai', label: 'OpenAI' }));
    expect(openai.sessions).toBeNull();
    expect(openai.desktop).toBeNull();

    const opencode = createAgent(makeConfig({ name: 'opencode', label: 'OpenCode' }));
    expect(opencode.sessions).not.toBeNull();
    expect(opencode.desktop).not.toBeNull();
  });
});
