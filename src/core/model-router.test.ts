import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { selectModel, getBrainClient, getClient, getClientForRole, setFailoverManager, clearCache } from './model-router.js';
import { loadConfig } from '../config/index.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { saveUserRoutingPreference } from '../memory/user-profile.js';
import { getDb } from '../store/db.js';
import { ModelNotAllowedError } from '../security/entitlements.js';
import type { ChatResponse, StreamChunk } from './llm.js';

let tmpDir: string;
const savedEnv: Record<string, string | undefined> = {};
// Must clear ALL provider API keys to prevent auto-detection from ~/.mozi/mozi.json or env
const keysToManage = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'MINIMAX_API_KEY', 'DEEPSEEK_API_KEY', 'MOONSHOT_API_KEY', 'GROQ_API_KEY',
  'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY',
  'QIANFAN_API_KEY', 'NVIDIA_API_KEY', 'ZAI_API_KEY', 'Z_AI_API_KEY',
  'XIAOMI_API_KEY', 'SYNTHETIC_API_KEY', 'VENICE_API_KEY', 'OLLAMA_API_KEY',
  'VLLM_API_KEY', 'BEDROCK_API_KEY',
];

// Clear any cached config to ensure test isolation
clearCache();

// Ensure config is loaded with defaults (no provider configured)
loadConfig('/nonexistent/config.yaml');

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  for (const key of keysToManage) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Reload config after clearing env so snapshot sees no usable providers
  clearCache();
  loadConfig('/nonexistent/config.yaml');
});

afterAll(() => {
  for (const key of keysToManage) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  teardownTestDb(tmpDir);
});

afterEach(() => {
  setFailoverManager(null);
  clearCache();
  loadConfig('/nonexistent/config.yaml');
});

function makeResponse(content: string, model: string): ChatResponse {
  return {
    content,
    usage: { input_tokens: 1, output_tokens: 1 },
    model,
    stop_reason: 'end_turn',
  };
}

describe('core/model-router', () => {
  // With default config: brain_provider is empty, brain.model is empty
  // When no provider is configured, provider resolves to ''

  it('high complexity → complex_subagent role', () => {
    const selection = selectModel({ complexity: 'high' });
    expect(selection.role).toBe('complex_subagent');
    expect(selection.provider).toBe('');
  });

  it('low complexity → simple_subagent role', () => {
    const selection = selectModel({ complexity: 'low' });
    expect(selection.role).toBe('simple_subagent');
    expect(selection.provider).toBe('');
  });

  it('type=summary → summary role', () => {
    const selection = selectModel({ type: 'summary' });
    expect(selection.role).toBe('summary');
    expect(selection.provider).toBe('');
  });

  it('type=code → code role', () => {
    const selection = selectModel({ type: 'code' });
    expect(selection.role).toBe('code');
    expect(selection.provider).toBe('');
  });

  it('high estimated_tokens → complex_subagent', () => {
    const selection = selectModel({ estimated_tokens: 10000 });
    expect(selection.role).toBe('complex_subagent');
  });

  it('default (no hints) → simple_subagent', () => {
    const selection = selectModel();
    expect(selection.role).toBe('simple_subagent');
  });

  it('fallback roles use brain_provider, not hardcoded providers', () => {
    // All roles should use the configured brain_provider (empty when not configured)
    const simple = selectModel({ complexity: 'low' });
    const summary = selectModel({ type: 'summary' });
    const complex = selectModel({ complexity: 'high' });
    const code = selectModel({ type: 'code' });

    expect(simple.provider).toBe('');
    expect(summary.provider).toBe('');
    expect(complex.provider).toBe('');
    expect(code.provider).toBe('');
  });

  it('keeps an implemented cli-pipe provider configured for brain and routed roles', () => {
    const dir = join(tmpdir(), `mozi-router-cli-brain-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    process.env.OPENAI_API_KEY = ['sk', 'openai-cli-brain-fallback'].join('-');
    writeFileSync(configPath, JSON.stringify({
      brain: { model: '_cli-default' },
      model_router: {
        brain_provider: 'claude-cli',
      },
    }));

    try {
      loadConfig(configPath);
      const { selection } = getBrainClient();

      expect(selection.provider).toBe('claude-cli');
      expect(selection.model).toBe('_cli-default');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.OPENAI_API_KEY;
      loadConfig('/nonexistent/config.yaml');
    }
  });

  it('inherits think from brain config when role-level think is not set', () => {
    const dir = join(tmpdir(), `mozi-router-think-default-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      brain: { think: 'high' },
      model_router: {
        brain_provider: 'openai',
        roles: {
          summary: { provider: 'openai', model: 'gpt-4.1-mini' },
        },
      },
    }));

    try {
      loadConfig(configPath);
      const selection = selectModel({ type: 'summary' });
      expect(selection.think).toBe('high');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      loadConfig('/nonexistent/config.yaml');
    }
  });

  it('uses role-level think override when configured', () => {
    const dir = join(tmpdir(), `mozi-router-think-role-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      brain: { think: 'high' },
      model_router: {
        brain_provider: 'openai',
        roles: {
          summary: { provider: 'openai', model: 'gpt-4.1-mini', think: 'low' },
        },
      },
    }));

    try {
      loadConfig(configPath);
      const selection = selectModel({ type: 'summary' });
      expect(selection.think).toBe('low');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      loadConfig('/nonexistent/config.yaml');
    }
  });

  it('throws a typed error when the selected brain model is outside the user grant', () => {
    const dir = join(tmpdir(), `mozi-router-entitlement-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      server: { auth_mode: 'local' },
      brain: { model: 'gpt-4.1' },
      model_router: {
        brain_provider: 'openai',
      },
    }));
    getDb().prepare(`
      INSERT INTO users (id, tenant_id, email, auth_provider, provider_id, role, status, allowed_models)
      VALUES ('router-user', 'router-tenant', 'router@example.com', 'local', 'router-user', 'viewer', 'active', ?)
    `).run(JSON.stringify(['gpt-4.1-mini']));

    try {
      loadConfig(configPath);
      expect(() => getBrainClient({ tenantId: 'router-tenant', userId: 'router-user' }))
        .toThrow(ModelNotAllowedError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      loadConfig('/nonexistent/config.yaml');
    }
  });

  it('applies per-user routing preferences when user context is provided', () => {
    const dir = join(tmpdir(), `mozi-router-user-pref-${Date.now()}`);
    const configPath = join(dir, 'mozi.json');
    mkdirSync(dir, { recursive: true });
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    process.env.ANTHROPIC_API_KEY = 'sk-anthropic-test';
    writeFileSync(configPath, JSON.stringify({
      model_router: {
        brain_provider: 'openai',
        routing_preferences: {
          preferred_summary: { provider: 'openai', model: 'gpt-4.1-mini' },
        },
      },
    }));

    try {
      loadConfig(configPath);
      saveUserRoutingPreference('preferred_summary_provider', 'anthropic', 'user-1', 'tenant-router-user');
      saveUserRoutingPreference('preferred_summary_model', 'claude-sonnet-4-20250514', 'user-1', 'tenant-router-user');

      const selection = selectModel(
        { type: 'summary' },
        { tenantId: 'tenant-router-user', userId: 'user-1' },
      );
      const fallbackSelection = selectModel(
        { type: 'summary' },
        { tenantId: 'tenant-router-user', userId: 'user-2' },
      );

      expect(selection.provider).toBe('anthropic');
      expect(selection.model).toBe('claude-sonnet-4-20250514');
      expect(selection.reason?.stage).toBe('preference_override');
      expect(fallbackSelection.provider).toBe('openai');
      expect(fallbackSelection.model).toBe('gpt-4.1-mini');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('routes chatStream through failover with the selected provider/model', async () => {
    const calls: Array<{ provider?: string; model?: string }> = [];
    setFailoverManager({
      chat: async (_messages, options) => makeResponse('ok', options?.model ?? ''),
      chatStream: async function* (_messages, options): AsyncGenerator<StreamChunk> {
        calls.push({ provider: options?.provider, model: options?.model });
        yield { type: 'text', text: 'streamed' };
        yield { type: 'done', response: makeResponse('streamed', options?.model ?? '') };
      },
    });

    const client = getClient({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      role: 'summary',
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(calls).toEqual([{ provider: 'openai', model: 'gpt-4.1-mini' }]);
    expect(chunks).toEqual([
      { type: 'text', text: 'streamed' },
      { type: 'done', response: makeResponse('streamed', 'gpt-4.1-mini') },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getClientForRole — step + plan_summary routing roles (W3)
// ---------------------------------------------------------------------------

describe('getClientForRole — step and plan_summary roles', () => {
  function makeFallbackClient() {
    return {
      provider: 'mock-fallback',
      chat: async () => makeResponse('mock', 'mock-model'),
      chatStream: async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'done', response: makeResponse('mock', 'mock-model') };
      },
    };
  }

  it('step role with fallback client returns the fallback when no provider configured', () => {
    const fallback = makeFallbackClient();
    const { client } = getClientForRole('step', fallback);
    expect(client).toBeDefined();
    expect(typeof client.chat).toBe('function');
  });

  it('plan_summary role with fallback client returns the fallback when no provider configured', () => {
    const fallback = makeFallbackClient();
    const { client } = getClientForRole('plan_summary', fallback);
    expect(client).toBeDefined();
    expect(typeof client.chat).toBe('function');
  });

  it('step role throws when no provider configured and no fallback client', () => {
    // Correct behavior: no provider, no fallback → throw rather than return a broken client.
    expect(() => getClientForRole('step')).toThrow(/getClientForRole.*no usable provider/);
  });

  it('plan_summary role throws when no provider configured and no fallback client', () => {
    expect(() => getClientForRole('plan_summary')).toThrow(/getClientForRole.*no usable provider/);
  });

  it('getClientForRole returns client + selection structure', () => {
    const fallback = makeFallbackClient();
    const result = getClientForRole('step', fallback);
    expect(result).toHaveProperty('client');
    expect(result).toHaveProperty('selection');
  });
});
