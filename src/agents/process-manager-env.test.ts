import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const forkMock = vi.fn();

vi.mock('node:child_process', () => ({
  fork: (...args: unknown[]) => forkMock(...args),
}));

vi.mock('./registry.js', () => ({
  incrementSpawnCount: vi.fn(),
}));

class MockStream extends EventEmitter {
  write = vi.fn(() => true);
}

class MockChild extends EventEmitter {
  stdout = new MockStream() as unknown as NodeJS.ReadableStream;
  stderr = new MockStream() as unknown as NodeJS.ReadableStream;
  stdin = new MockStream() as unknown as NodeJS.WritableStream;
  pid = 43210;

  kill = vi.fn((_signal?: NodeJS.Signals) => {
    this.emit('exit', 0, null);
    return true;
  });
}

function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe('agents/process-manager env wiring', () => {
  beforeEach(() => {
    forkMock.mockReset();
  });

  it('passes brain-selected provider/model to subagent worker env', async () => {
    const child = new MockChild();
    forkMock.mockReturnValue(child);

    const { spawn, kill } = await import('./process-manager.js');
    const proc = spawn('coder', {
      system_prompt: 'You are coder.',
      tools_allowed: ['shell_exec'],
      permission_level: 'L2_SHELL_EXEC',
      llm_provider: 'minimax',
      llm_model: 'MiniMax-M2.5',
    });

    expect(proc.id).toBeTruthy();
    expect(forkMock).toHaveBeenCalledTimes(1);

    const options = forkMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
    expect(options?.env?.MOZI_LLM_PROVIDER).toBe('minimax');
    expect(options?.env?.MOZI_LLM_MODEL).toBe('MiniMax-M2.5');
    expect(options?.env?.MOZI_SYSTEM_PROMPT).toBe('You are coder.');
    expect(options?.env?.MOZI_TOOLS_ALLOWED).toBe(JSON.stringify(['shell_exec']));
    expect(options?.env?.MOZI_PERMISSION_LEVEL).toBe('L2_SHELL_EXEC');

    await kill(proc.id);
  });

  it('uses explicit tenant_id for subagent worker env', async () => {
    const child = new MockChild();
    forkMock.mockReturnValue(child);

    const { spawn, kill } = await import('./process-manager.js');
    const proc = spawn('coder', {
      tenant_id: 'tenant_acme',
    });

    const options = forkMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
    expect(options?.env?.MOZI_TENANT_ID).toBe('tenant_acme');

    await kill(proc.id);
  });

  it('applies env allowlist and excludes unrelated parent secrets', async () => {
    const child = new MockChild();
    forkMock.mockReturnValue(child);

    const backup = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      OPENAI_API_KEY_1: process.env.OPENAI_API_KEY_1,
      SEARCH1API_KEY: process.env.SEARCH1API_KEY,
      JWT_SECRET: process.env.JWT_SECRET,
      MOZI_MASTER_PASSWORD: process.env.MOZI_MASTER_PASSWORD,
      CUSTOM_SAFE_ENV: process.env.CUSTOM_SAFE_ENV,
      MOZI_SUBAGENT_ENV_ALLOWLIST: process.env.MOZI_SUBAGENT_ENV_ALLOWLIST,
    };

    process.env.OPENAI_API_KEY = 'openai-test-key';
    process.env.OPENAI_API_KEY_1 = 'openai-test-key-1';
    process.env.SEARCH1API_KEY = 'search-test-key';
    process.env.JWT_SECRET = 'jwt-should-not-leak';
    process.env.MOZI_MASTER_PASSWORD = 'master-should-not-leak';
    process.env.CUSTOM_SAFE_ENV = 'safe-pass-through';
    process.env.MOZI_SUBAGENT_ENV_ALLOWLIST = 'CUSTOM_SAFE_ENV';

    try {
      const { spawn, kill } = await import('./process-manager.js');
      const proc = spawn('coder');

      const options = forkMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
      expect(options?.env?.OPENAI_API_KEY).toBe('openai-test-key');
      expect(options?.env?.OPENAI_API_KEY_1).toBe('openai-test-key-1');
      expect(options?.env?.SEARCH1API_KEY).toBe('search-test-key');
      expect(options?.env?.CUSTOM_SAFE_ENV).toBe('safe-pass-through');

      expect(options?.env?.JWT_SECRET).toBeUndefined();
      expect(options?.env?.MOZI_MASTER_PASSWORD).toBeUndefined();

      await kill(proc.id);
    } finally {
      restoreEnvVar('OPENAI_API_KEY', backup.OPENAI_API_KEY);
      restoreEnvVar('OPENAI_API_KEY_1', backup.OPENAI_API_KEY_1);
      restoreEnvVar('SEARCH1API_KEY', backup.SEARCH1API_KEY);
      restoreEnvVar('JWT_SECRET', backup.JWT_SECRET);
      restoreEnvVar('MOZI_MASTER_PASSWORD', backup.MOZI_MASTER_PASSWORD);
      restoreEnvVar('CUSTOM_SAFE_ENV', backup.CUSTOM_SAFE_ENV);
      restoreEnvVar('MOZI_SUBAGENT_ENV_ALLOWLIST', backup.MOZI_SUBAGENT_ENV_ALLOWLIST);
    }
  });
});
