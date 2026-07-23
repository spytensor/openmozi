import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { CliBackendConfig } from './providers.js';

const hoisted = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  calls: [] as Array<{ command: string; args: string[]; options?: { stdio?: string[] } }>,
  responses: [] as Array<{ stdout: string; stderr: string; exitCode: number; stayOpen?: boolean }>,
  children: [] as Array<EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    stdinChunks: Buffer[];
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('node:child_process', () => ({
  spawn: hoisted.spawnMock,
}));

import { createCliAdapter } from './llm-cli.js';

function makeProc(command: string, args: string[], options?: { stdio?: string[] }): EventEmitter & {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
  stdinChunks: Buffer[];
  pid: number;
  kill: ReturnType<typeof vi.fn>;
} {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    stdinChunks: Buffer[];
    pid: number;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.stdin = new PassThrough();
  proc.stdinChunks = [];
  proc.pid = 42000 + hoisted.children.length + 1;
  proc.kill = vi.fn(() => true);
  proc.stdin.on('data', chunk => proc.stdinChunks.push(Buffer.from(chunk)));

  hoisted.calls.push({ command, args: [...args], options });
  hoisted.children.push(proc);
  const response = hoisted.responses.shift() ?? {
    stdout: '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}\n',
    stderr: '',
    exitCode: 0,
  };

  if (!response.stayOpen) {
    queueMicrotask(() => {
      if (response.stdout) proc.stdout.write(response.stdout);
      proc.stdout.end();
      if (response.stderr) proc.stderr.write(response.stderr);
      proc.stderr.end();
      proc.emit('close', response.exitCode);
    });
  }

  return proc;
}

describe('core/llm-cli', () => {
  beforeEach(() => {
    hoisted.calls.length = 0;
    hoisted.responses.length = 0;
    hoisted.children.length = 0;
    hoisted.spawnMock.mockReset();
    hoisted.spawnMock.mockImplementation((command: string, args: string[], options?: { stdio?: string[] }) => makeProc(command, args, options));
  });

  it('uses backend-specific stdin args for UTF-8 prompts at the byte threshold', async () => {
    const prompt = '中'.repeat(30_000);
    const backend: CliBackendConfig = {
      command: 'gemini', args: ['--output-format', 'json'], input: 'arg', output: 'json',
      promptArg: '-p', stdinPromptArgs: ['-p', ''], maxPromptArgBytes: 65_536,
      sessionMode: 'none',
    };
    hoisted.responses.push({ stdout: '{"result":"OK"}', stderr: '', exitCode: 0 });

    const client = createCliAdapter('gemini-cli', '_cli-default', backend);
    await client.chat([{ role: 'user', content: prompt }]);

    expect(hoisted.calls[0]?.args).toEqual(['--output-format', 'json', '-p', '']);
    expect(hoisted.calls[0]?.args.some(arg => arg.includes(prompt))).toBe(false);
    expect(Buffer.concat(hoisted.children[0]!.stdinChunks).toString()).toBe(prompt);
  });

  it('rejects stdin delivery errors even when the child closes with zero', async () => {
    const backend: CliBackendConfig = {
      command: 'codex', args: ['exec', '--json'], input: 'arg', output: 'jsonl',
      stdinPromptArgs: ['-'], maxPromptArgBytes: 65_536, sessionMode: 'none',
    };
    hoisted.responses.push({ stdout: '', stderr: '', exitCode: 0, stayOpen: true });
    const client = createCliAdapter('codex-cli', '_cli-default', backend);
    const response = client.chat([{ role: 'user', content: 'x'.repeat(65_536) }]);
    await vi.waitFor(() => expect(hoisted.children).toHaveLength(1));
    const child = hoisted.children[0]!;
    child.stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));
    child.emit('close', 0);

    await expect(response).rejects.toThrow('CLI prompt delivery failed on stdin (EPIPE)');
  });

  it('kills and rejects with the stdin error when the child never closes', async () => {
    vi.useFakeTimers();
    try {
      const backend: CliBackendConfig = {
        command: 'codex', args: ['exec', '--json'], input: 'arg', output: 'jsonl',
        stdinPromptArgs: ['-'], maxPromptArgBytes: 65_536, sessionMode: 'none',
      };
      hoisted.responses.push({ stdout: '', stderr: '', exitCode: 0, stayOpen: true });
      const client = createCliAdapter('codex-cli', '_cli-default', backend);
      const response = client.chat([{ role: 'user', content: 'x'.repeat(65_536) }]);
      await vi.waitFor(() => expect(hoisted.children).toHaveLength(1));
      const child = hoisted.children[0]!;
      child.stdin.emit('error', Object.assign(new Error('closed pipe'), { code: 'EPIPE' }));

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      const rejection = expect(response).rejects.toThrow('CLI prompt delivery failed on stdin (EPIPE)');
      await vi.advanceTimersByTimeAsync(2_250);
      await rejection;
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an oversized final argv before arming timeout resources', async () => {
    vi.useFakeTimers();
    try {
      const backend: CliBackendConfig = {
        command: 'codex', args: ['exec', '--json'], input: 'arg', output: 'jsonl',
        systemPromptArg: '-c', systemPromptWhen: 'always', sessionMode: 'none',
      };
      const client = createCliAdapter('codex-cli', '_cli-default', backend);

      await expect(client.chat([
        { role: 'system', content: 's'.repeat(131_072) },
        { role: 'user', content: 'go' },
      ])).rejects.toThrow('CLI spawn budget exceeded for argv');
      expect(hoisted.spawnMock).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('encodes codex system prompt using developer_instructions config key', async () => {
    const backend: CliBackendConfig = {
      command: 'codex',
      args: ['exec', '--json', '--color', 'never'],
      input: 'arg',
      output: 'jsonl',
      modelArg: '--model',
      fixedModel: 'gpt-5.3-codex',
      systemPromptArg: '-c',
      systemPromptFormat: 'codex-config-instructions',
      systemPromptWhen: 'always',
      sessionMode: 'none',
    };

    const client = createCliAdapter('codex-cli', 'gpt-5.3-codex', backend);
    const response = await client.chat([
      { role: 'system', content: 'You are a strict runtime policy.' },
      { role: 'user', content: 'Reply with OK.' },
    ], { model: 'gpt-5.3-codex' });

    expect(response.content).toBe('OK');
    expect(hoisted.calls.length).toBe(1);
    const call = hoisted.calls[0];
    const cfgIdx = call.args.indexOf('-c');
    expect(cfgIdx).toBeGreaterThanOrEqual(0);
    const cfg = call.args[cfgIdx + 1];
    expect(cfg).toBe('developer_instructions="You are a strict runtime policy."');
    expect(cfg.startsWith('instructions=')).toBe(false);
  });

  it('ignores stale cached session IDs when backend sessionMode is none', async () => {
    const sessionBackend: CliBackendConfig = {
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      resumeArgs: ['-p', '--output-format', 'json', '--resume'],
      input: 'arg',
      output: 'json',
      modelArg: '--model',
      sessionArg: '--session-id',
      sessionMode: 'existing',
      sessionIdFields: ['conversation_id'],
    };

    hoisted.responses.push(
      { stdout: '{"result":"seeded","conversation_id":"sess-123"}\n', stderr: '', exitCode: 0 },
      { stdout: '{"result":"fresh"}\n', stderr: '', exitCode: 0 },
    );

    const seededClient = createCliAdapter('claude-cli', 'claude-sonnet-4-6', sessionBackend);
    await seededClient.chat(
      [{ role: 'user', content: 'seed session' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-1' } as any,
    );

    const noSessionBackend: CliBackendConfig = {
      ...sessionBackend,
      sessionMode: 'none',
    };
    const noSessionClient = createCliAdapter('claude-cli', 'claude-sonnet-4-6', noSessionBackend);
    await noSessionClient.chat(
      [{ role: 'user', content: 'no session mode' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-1' } as any,
    );

    expect(hoisted.calls.length).toBe(2);
    const secondCall = hoisted.calls[1];
    expect(secondCall.args).not.toContain('--resume');
    expect(secondCall.args).not.toContain('--session-id');
  });

  it('clears cached session and retries once on session-conflict failures', async () => {
    const backend: CliBackendConfig = {
      command: 'claude',
      args: ['-p', '--output-format', 'json'],
      resumeArgs: ['-p', '--output-format', 'json', '--resume'],
      input: 'arg',
      output: 'json',
      modelArg: '--model',
      sessionArg: '--session-id',
      sessionMode: 'existing',
      sessionIdFields: ['conversation_id'],
    };

    hoisted.responses.push(
      { stdout: '{"result":"seeded","conversation_id":"sess-abc"}\n', stderr: '', exitCode: 0 },
      { stdout: '', stderr: 'Error: Session ID sess-abc is already in use.', exitCode: 1 },
      { stdout: '{"result":"recovered"}\n', stderr: '', exitCode: 0 },
    );

    const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);

    await client.chat(
      [{ role: 'user', content: 'seed session' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-2' } as any,
    );

    const recovered = await client.chat(
      [{ role: 'user', content: 'run with stale session' }],
      { model: 'claude-sonnet-4-6', cliSessionKey: 'chat-2' } as any,
    );

    expect(recovered.content).toBe('recovered');
    expect(hoisted.calls.length).toBe(3);
    expect(hoisted.calls[1].args).toContain('--resume');
    expect(hoisted.calls[2].args).not.toContain('--resume');
    expect(hoisted.calls[2].args).not.toContain('--session-id');
  });

  it('honors caller timeout_ms override for CLI calls', async () => {
    vi.useFakeTimers();
    try {
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();

        const signal = options?.signal;
        signal?.addEventListener('abort', () => {
          proc.emit('error', new Error('The operation was aborted'));
        }, { once: true });

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 180_000,
        sessionMode: 'none',
      };

      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        timeout_ms: 5,
      });
      const assertion = expect(promise).rejects.toThrow('timed out after 5ms');

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(2_250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills the CLI child on caller abort and escalates if it does not exit', async () => {
    vi.useFakeTimers();
    try {
      const killMock = vi.fn((_signal?: NodeJS.Signals) => true);
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        proc.kill = killMock;

        options?.signal?.addEventListener('abort', () => {
          proc.emit('error', new Error('The operation was aborted'));
        }, { once: true });

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 180_000,
        sessionMode: 'none',
      };

      const controller = new AbortController();
      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        abort_signal: controller.signal,
      });

      controller.abort(new Error('Stop now'));
      await vi.advanceTimersByTimeAsync(0);
      expect(killMock).toHaveBeenCalledWith('SIGTERM');

      await vi.advanceTimersByTimeAsync(2_000);
      expect(killMock).toHaveBeenCalledWith('SIGKILL');

      const assertion = expect(promise).rejects.toThrow('Stop now');
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a generous interactive CLI timeout without applying the old 45s cap', async () => {
    vi.useFakeTimers();
    try {
      const killMock = vi.fn((_signal?: NodeJS.Signals) => true);
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
          kill: ReturnType<typeof vi.fn>;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();
        proc.kill = killMock;

        options?.signal?.addEventListener('abort', () => {
          proc.emit('error', new Error('The operation was aborted'));
        }, { once: true });

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 180_000,
        sessionMode: 'none',
      };

      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        timeout_ms: 300_000,
        execution_scope: 'interactive',
      });
      const assertion = expect(promise).rejects.toThrow('The CLI model did not respond in time (300000ms).');

      await vi.advanceTimersByTimeAsync(299_999);
      expect(killMock).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(killMock).toHaveBeenCalledWith('SIGTERM');
      await vi.advanceTimersByTimeAsync(2_000);
      expect(killMock).toHaveBeenCalledWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(250);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats timeout_ms=0 as disabled for this call', async () => {
    vi.useFakeTimers();
    try {
      hoisted.spawnMock.mockImplementation((_command: string, _args: string[], _options?: { signal?: AbortSignal }) => {
        const proc = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          stdin: PassThrough;
        };
        proc.stdout = new PassThrough();
        proc.stderr = new PassThrough();
        proc.stdin = new PassThrough();

        setTimeout(() => {
          proc.stdout.write('{"result":"late ok"}\n');
          proc.stdout.end();
          proc.stderr.end();
          proc.emit('close', 0);
        }, 20);

        return proc;
      });

      const backend: CliBackendConfig = {
        command: 'claude',
        args: ['-p', '--output-format', 'json'],
        input: 'arg',
        output: 'json',
        modelArg: '--model',
        timeoutMs: 5,
        sessionMode: 'none',
      };

      const client = createCliAdapter('claude-cli', 'claude-sonnet-4-6', backend);
      const promise = client.chat([{ role: 'user', content: 'hello' }], {
        model: 'claude-sonnet-4-6',
        timeout_ms: 0,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(promise).resolves.toMatchObject({ content: 'late ok' });
    } finally {
      vi.useRealTimers();
    }
  });
});
