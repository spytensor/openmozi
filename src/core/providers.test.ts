import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getProvider,
  getAllProviders,
  getWizardProviders,
  resolveApiKey,
  resolveApiKeys,
  resolveBaseUrl,
  resolveApiMode,
  getModel,
  isChatRoleEligibleProvider,
  detectConfiguredProviders,
  migrateEnvVars,
} from './providers.js';

// Mock paths module to avoid touching real files
vi.mock('../paths.js', () => ({
  getEnvPath: () => '/tmp/test-mozi-env',
  getConfigPath: () => '/tmp/test-mozi-config.yaml',
}));

// Mock fs to prevent actual file operations
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
  };
});

describe('core/providers', () => {
  const originalEnv = process.env;
  const envKeysToClear = [
    'OPENAI_API_KEY',
    'OPENAI_API_KEYS',
    'OPENAI_API_KEY_1',
    'OPENAI_API_KEY_2',
    'MOZI_LIVE_OPENAI_KEY',
    'ANTHROPIC_API_KEY',
    'MINIMAX_API_KEY',
    'DEEPSEEK_API_KEY',
    'MOONSHOT_API_KEY',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'GROQ_API_KEYS',
    'TOGETHER_API_KEY',
    'OPENROUTER_API_KEY',
    'XAI_API_KEY',
    'MISTRAL_API_KEY',
    'HUGGINGFACE_HUB_TOKEN',
    'HF_TOKEN',
    'QIANFAN_API_KEY',
    'NVIDIA_API_KEY',
    'ZAI_API_KEY',
    'Z_AI_API_KEY',
    'XIAOMI_API_KEY',
    'SYNTHETIC_API_KEY',
    'VENICE_API_KEY',
    'OLLAMA_API_KEY',
    'VLLM_API_KEY',
    'BEDROCK_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'OPENAI_BASE_URL',
    'GOOGLE_BASE_URL',
    'GEMINI_BASE_URL',
  ];

  beforeEach(() => {
    process.env = { ...originalEnv };
    for (const key of envKeysToClear) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('getProvider returns known provider definitions with apiMode', () => {
    const openai = getProvider('openai');
    expect(openai).toBeDefined();
    expect(openai!.envKey).toBe('OPENAI_API_KEY');
    expect(openai!.apiMode).toBe('openai-responses');
    expect(openai!.apiType).toBe('openai-responses');

    const anthropic = getProvider('anthropic');
    expect(anthropic!.apiMode).toBe('anthropic');

    const google = getProvider('google');
    expect(google!.envKey).toBe('GEMINI_API_KEY');
    expect(google!.env.keyAliases).toContain('GOOGLE_API_KEY');
  });

  it('getProvider returns undefined for unknown provider', () => {
    expect(getProvider('nonexistent')).toBeUndefined();
  });

  it('resolveApiMode returns provider api mode', () => {
    expect(resolveApiMode('bedrock')).toBe('bedrock-converse-stream');
    expect(resolveApiMode('ollama')).toBe('ollama-native');
    expect(resolveApiMode('nonexistent')).toBeUndefined();
  });

  it('each model has required metadata fields', () => {
    const providers = getAllProviders();
    for (const provider of providers) {
      for (const model of provider.models) {
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxOutputTokens).toBeGreaterThan(0);
        expect(typeof model.supportsTools).toBe('boolean');
        expect(typeof model.supportsStreaming).toBe('boolean');
        expect(typeof model.supportsVision).toBe('boolean');
      }
    }
  });

  it('getModel returns exact model definition', () => {
    const model = getModel('openai', 'gpt-4.1-mini');
    expect(model).toBeDefined();
    expect(model!.name).toBe('GPT-4.1 Mini');
    expect(model!.contextWindow).toBe(1_047_576);
    expect(model!.supportsTools).toBe(true);
  });

  it('getModel applies forward-compat template fallback', () => {
    const anthropicModel = getModel('anthropic', 'claude-sonnet-4-20260101');
    expect(anthropicModel).toBeDefined();
    expect(anthropicModel!.id).toBe('claude-sonnet-4-20260101');
    expect(anthropicModel!.contextWindow).toBe(200_000);

    const openaiModel = getModel('openai', 'gpt-5.3');
    expect(openaiModel).toBeDefined();
    expect(openaiModel!.id).toBe('gpt-5.3');

    const deepseekModel = getModel('deepseek', 'deepseek-v4-pro-202604');
    expect(deepseekModel).toBeDefined();
    expect(deepseekModel!.id).toBe('deepseek-v4-pro-202604');
    expect(deepseekModel!.contextWindow).toBe(1_048_576);
  });

  it('registers DeepSeek V4 models as the canonical DeepSeek catalog entries', () => {
    const deepseek = getProvider('deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek!.baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek!.defaultModel).toBe('deepseek-v4-flash');

    const flash = getModel('deepseek', 'deepseek-v4-flash');
    expect(flash).toMatchObject({
      name: 'DeepSeek V4 Flash',
      supportsTools: true,
      reasoning: true,
      contextWindow: 1_048_576,
    });

    const pro = getModel('deepseek', 'deepseek-v4-pro');
    expect(pro).toMatchObject({
      name: 'DeepSeek V4 Pro',
      tier: 'high',
      supportsTools: true,
      reasoning: true,
      contextWindow: 1_048_576,
    });
  });

  it('getModel returns undefined for unknown provider/model family', () => {
    expect(getModel('openai', 'unknown-family-model')).toBeUndefined();
    expect(getModel('nonexistent', 'gpt-4.1')).toBeUndefined();
  });

  it('getAllProviders returns broad provider catalog', () => {
    const all = getAllProviders();
    expect(all.length).toBeGreaterThanOrEqual(20);

    const ids = all.map(p => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('minimax');
    expect(ids).toContain('moonshot');
    expect(ids).toContain('together');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('xai');
    expect(ids).toContain('groq');
    expect(ids).toContain('mistral');
    expect(ids).toContain('huggingface');
    expect(ids).toContain('qianfan');
    expect(ids).toContain('nvidia');
    expect(ids).toContain('zai');
    expect(ids).toContain('xiaomi');
    expect(ids).toContain('synthetic');
    expect(ids).toContain('venice');
    expect(ids).toContain('ollama');
    expect(ids).toContain('vllm');
    expect(ids).toContain('bedrock');
  });

  it('getWizardProviders returns curated mainstream list', () => {
    const wizard = getWizardProviders();
    const ids = wizard.map(p => p.id);
    expect(ids).toContain('openai');
    expect(ids).toContain('anthropic');
    expect(ids).toContain('google');
    expect(ids).toContain('openrouter');
    expect(ids).not.toContain('bedrock');
  });

  it('resolveApiKeys follows live > list > primary > numbered precedence', () => {
    process.env.MOZI_LIVE_OPENAI_KEY = 'live-key';
    process.env.OPENAI_API_KEYS = 'list-a; list-b, list-c';
    process.env.OPENAI_API_KEY = 'primary-key';
    process.env.OPENAI_API_KEY_2 = 'num-2';
    process.env.OPENAI_API_KEY_1 = 'num-1';

    expect(resolveApiKeys('openai')).toEqual([
      'live-key',
      'list-a',
      'list-b',
      'list-c',
      'primary-key',
      'num-1',
      'num-2',
    ]);
    expect(resolveApiKey('openai')).toBe('live-key');
  });

  it('resolveApiKeys deduplicates repeated values', () => {
    process.env.OPENAI_API_KEYS = 'same-key,same-key';
    process.env.OPENAI_API_KEY = 'same-key';
    process.env.OPENAI_API_KEY_1 = 'same-key';

    expect(resolveApiKeys('openai')).toEqual(['same-key']);
  });

  it('resolveApiKey supports provider aliases (Google + Z.AI)', () => {
    process.env.GOOGLE_API_KEY = 'google-alias-key';
    expect(resolveApiKey('google')).toBe('google-alias-key');

    process.env.GEMINI_API_KEY = 'gemini-primary-key';
    expect(resolveApiKey('google')).toBe('gemini-primary-key');

    process.env.Z_AI_API_KEY = 'zai-alias';
    expect(resolveApiKey('zai')).toBe('zai-alias');
  });

  it('resolveBaseUrl respects configured base URL aliases and precedence', () => {
    expect(resolveBaseUrl('google')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');

    process.env.GOOGLE_BASE_URL = 'https://google-base-url';
    expect(resolveBaseUrl('google')).toBe('https://google-base-url');

    process.env.GEMINI_BASE_URL = 'https://gemini-base-url';
    expect(resolveBaseUrl('google')).toBe('https://gemini-base-url');
  });

  it('detectConfiguredProviders detects providers from normalized env schemes', () => {
    process.env.GROQ_API_KEYS = 'groq-a,groq-b';
    process.env.OPENAI_API_KEY_1 = 'openai-numbered';

    const detected = detectConfiguredProviders();
    const ids = detected.map(p => p.id);

    expect(ids).toContain('groq');
    expect(ids).toContain('openai');
    // openai-codex is intentionally opt-in only (not auto-detected)
    expect(ids).not.toContain('openai-codex');
  });

  it('detectConfiguredProviders returns empty when no keys set', () => {
    expect(detectConfiguredProviders()).toHaveLength(0);
  });

  it('migrateEnvVars migrates minimax OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'eyJ-minimax-key';
    process.env.OPENAI_BASE_URL = 'https://api.minimax.chat/v1';

    const result = migrateEnvVars();
    expect(result.migrated.length).toBeGreaterThan(0);
    expect(result.migrated[0]).toContain('MINIMAX_API_KEY');
    expect(process.env.MINIMAX_API_KEY).toBe('eyJ-minimax-key');
  });

  it('migrateEnvVars migrates moonshot OPENAI_API_KEY', () => {
    process.env.OPENAI_API_KEY = 'sk-moonshot-key';
    process.env.OPENAI_BASE_URL = 'https://api.moonshot.ai/v1';

    const result = migrateEnvVars();
    expect(result.migrated.length).toBeGreaterThan(0);
    expect(result.migrated[0]).toContain('MOONSHOT_API_KEY');
    expect(process.env.MOONSHOT_API_KEY).toBe('sk-moonshot-key');
  });

  it('migrateEnvVars no-op when already migrated', () => {
    process.env.MINIMAX_API_KEY = 'already-set';
    process.env.OPENAI_API_KEY = 'eyJ-minimax-key';
    process.env.OPENAI_BASE_URL = 'https://api.minimax.chat/v1';

    const result = migrateEnvVars();
    expect(result.migrated).toHaveLength(0);
    expect(process.env.MINIMAX_API_KEY).toBe('already-set');
  });

  it('migrateEnvVars no-op when no legacy config', () => {
    const result = migrateEnvVars();
    expect(result.migrated).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it('provider definitions have unique provider ids', () => {
    const all = getAllProviders();
    const ids = new Set<string>();

    for (const p of all) {
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
      // CLI-pipe providers don't need API keys
      if (p.apiMode !== 'cli-pipe') {
        expect(p.env.primaryKey.length).toBeGreaterThan(0);
      }
    }
  });

  it('each provider has a valid defaultModel in its models list', () => {
    const all = getAllProviders();
    for (const p of all) {
      const modelIds = p.models.map(m => m.id);
      expect(modelIds).toContain(p.defaultModel);
    }
  });

  it('allows implemented CLI chat providers but still rejects Gemini CLI', () => {
    expect(isChatRoleEligibleProvider('claude-cli')).toBe(true);
    expect(isChatRoleEligibleProvider('codex-cli')).toBe(true);
    expect(isChatRoleEligibleProvider('gemini-cli')).toBe(false);
  });

  it('exposes multiple selectable models for implemented CLI providers', () => {
    expect(getProvider('claude-cli')?.models.map(model => model.id)).toEqual(
      expect.arrayContaining(['_cli-default', 'sonnet', 'opus']),
    );
    expect(getProvider('codex-cli')?.models.map(model => model.id)).toEqual(
      expect.arrayContaining(['_cli-default', 'gpt-5.3-codex', 'gpt-5.2-codex']),
    );
  });

  it('each provider has at least one model', () => {
    const all = getAllProviders();
    for (const p of all) {
      expect(p.models.length).toBeGreaterThan(0);
    }
  });
});
