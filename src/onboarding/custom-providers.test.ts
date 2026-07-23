import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  detectProviders,
  saveCustomProviderToConfig,
  startSession,
  processOnboardingMessage,
  getSession,
  endSession,
  type OnboardingState,
} from './index.js';
import { resetTableFlag } from './state.js';
import { getAllProviders, getProvider } from '../core/providers.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'js-yaml';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { readEnvVar, readPersistedSecret } from './persistence.js';
import { generateMasterKey, getSecret } from '../security/secrets.js';

describe('provider registry integration', () => {
  it('registry contains expected custom providers', () => {
    const all = getAllProviders();
    const ids = all.map(p => p.id);
    expect(ids).toContain('groq');
    expect(ids).toContain('together');
    expect(ids).toContain('openrouter');
    expect(ids).toContain('ollama');
  });

  it('each provider has required fields', () => {
    for (const provider of getAllProviders()) {
      expect(provider.id).toBeTruthy();
      expect(provider.name).toBeTruthy();
      // CLI-pipe providers use local CLI tools — no baseUrl or envKey needed
      if (provider.apiMode !== 'cli-pipe') {
        expect(provider.baseUrl).toBeTruthy();
      }
      expect(provider.models.length).toBeGreaterThan(0);
      for (const m of provider.models) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(m.contextWindow).toBeGreaterThan(0);
        expect(m.maxOutputTokens).toBeGreaterThan(0);
      }
    }
  });

  it('ollama has OLLAMA_API_KEY envKey', () => {
    const ollama = getProvider('ollama');
    expect(ollama).toBeDefined();
    expect(ollama!.envKey).toBe('OLLAMA_API_KEY');
  });
});

describe('detectProviders with registry', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = ['GROQ_API_KEY', 'TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'OLLAMA_API_KEY',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
    'MINIMAX_API_KEY', 'MINIMAX_BASE_URL', 'MOONSHOT_API_KEY'];

  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  it('detects Groq provider when GROQ_API_KEY is set', () => {
    process.env.GROQ_API_KEY = 'test-groq-key';
    const providers = detectProviders();
    const groq = providers.find(p => p.id === 'groq');
    expect(groq).toBeDefined();
    expect(groq!.name).toBe('Groq');
    expect(groq!.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(groq!.apiKey).toBe('test-groq-key');
    expect(groq!.models.length).toBeGreaterThan(0);
  });

  it('detects Together provider when TOGETHER_API_KEY is set', () => {
    process.env.TOGETHER_API_KEY = 'test-together-key';
    const providers = detectProviders();
    const together = providers.find(p => p.id === 'together');
    expect(together).toBeDefined();
    expect(together!.name).toBe('Together AI');
  });

  it('detects OpenRouter provider when OPENROUTER_API_KEY is set', () => {
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    const providers = detectProviders();
    const openrouter = providers.find(p => p.id === 'openrouter');
    expect(openrouter).toBeDefined();
    expect(openrouter!.name).toBe('OpenRouter');
  });

  it('does not detect Ollama without env key', () => {
    const providers = detectProviders();
    const ollama = providers.find(p => p.id === 'ollama');
    expect(ollama).toBeUndefined();
  });

  it('detects multiple custom providers simultaneously', () => {
    process.env.GROQ_API_KEY = 'key1';
    process.env.TOGETHER_API_KEY = 'key2';
    const providers = detectProviders();
    expect(providers.filter(p => ['groq', 'together'].includes(p.id))).toHaveLength(2);
  });

  it('detects both known and custom providers', () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.GROQ_API_KEY = 'groq-key';
    const providers = detectProviders();
    expect(providers.find(p => p.id === 'openai')).toBeDefined();
    expect(providers.find(p => p.id === 'groq')).toBeDefined();
  });

  it('respects provider base URL override from env', () => {
    process.env.MINIMAX_API_KEY = 'minimax-key';
    process.env.MINIMAX_BASE_URL = 'https://api.minimax.chat/anthropic/v1';

    const providers = detectProviders();
    const minimax = providers.find(p => p.id === 'minimax');

    expect(minimax).toBeDefined();
    expect(minimax!.baseUrl).toBe('https://api.minimax.chat/anthropic/v1');
  });
});

describe('saveCustomProviderToConfig', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `mozi-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'config.yaml');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates new config with providers section', () => {
    saveCustomProviderToConfig('https://api.groq.com/openai/v1', 'test-key', 'llama-3.3-70b', configPath);

    const content = readFileSync(configPath, 'utf-8');
    const config = yaml.load(content) as Record<string, unknown>;
    expect(config.providers).toBeDefined();
    const providers = config.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0].base_url).toBe('https://api.groq.com/openai/v1');
    expect(providers[0].api_key).toBe('test-key');
    expect(providers[0].model).toBe('llama-3.3-70b');
  });

  it('appends to existing providers', () => {
    writeFileSync(configPath, yaml.dump({ brain: { model: 'test' }, providers: [{ base_url: 'existing' }] }));
    saveCustomProviderToConfig('https://new.com/v1', 'key2', 'model2', configPath);

    const content = readFileSync(configPath, 'utf-8');
    const config = yaml.load(content) as Record<string, unknown>;
    const providers = config.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(2);
    expect((config.brain as Record<string, unknown>).model).toBe('test'); // existing preserved
  });

  it('omits api_key when empty', () => {
    saveCustomProviderToConfig('http://localhost:11434/v1', '', 'llama3.3', configPath);

    const content = readFileSync(configPath, 'utf-8');
    const config = yaml.load(content) as Record<string, unknown>;
    const providers = config.providers as Array<Record<string, unknown>>;
    expect(providers[0].api_key).toBeUndefined();
  });
});

describe('onboarding search key step', () => {
  const chatId = 'test-chat-search-step';
  let dbTmpDir: string;
  let moziHomeBackup: string | undefined;
  let searchKeyBackup: string | undefined;
  let localMoziHome: string;

  beforeEach(() => {
    const dbSetup = setupTestDb();
    dbTmpDir = dbSetup.tmpDir;
    resetTableFlag();
    localMoziHome = join(tmpdir(), `mozi-onboarding-search-${Date.now()}`);
    mkdirSync(localMoziHome, { recursive: true });
    moziHomeBackup = process.env.MOZI_HOME;
    searchKeyBackup = process.env.SEARCH1API_KEY;
    process.env.MOZI_HOME = localMoziHome;
    delete process.env.SEARCH1API_KEY;
  });

  afterEach(() => {
    endSession(chatId);
    teardownTestDb(dbTmpDir);
    if (moziHomeBackup === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = moziHomeBackup;
    if (searchKeyBackup === undefined) delete process.env.SEARCH1API_KEY;
    else process.env.SEARCH1API_KEY = searchKeyBackup;
    rmSync(localMoziHome, { recursive: true, force: true });
  });

  it('allows skipping SEARCH1API_KEY and advances to channel setup', async () => {
    const session = startSession(chatId);
    session.step = 'configure_search';

    const reply = await processOnboardingMessage(chatId, 'skip');
    expect(reply).toContain('SEARCH1API_KEY skipped');
    expect(getSession(chatId)?.step).toBe('configure_channels');
  });

  it('accepts SEARCH1API_KEY and enables web tools', async () => {
    const session = startSession(chatId);
    session.step = 'configure_search';

    const reply = await processOnboardingMessage(chatId, 'search-key-123');
    expect(reply).toContain('SEARCH1API_KEY configured');
    expect(getSession(chatId)?.step).toBe('configure_channels');
    expect(process.env.SEARCH1API_KEY).toBe('search-key-123');
  });
});

describe('onboarding provider key persistence', () => {
  const chatId = 'test-chat-provider-persistence';
  let dbTmpDir: string;
  let moziHomeBackup: string | undefined;
  let openAiKeyBackup: string | undefined;
  let localMoziHome: string;

  beforeEach(() => {
    const dbSetup = setupTestDb();
    dbTmpDir = dbSetup.tmpDir;
    resetTableFlag();
    localMoziHome = join(tmpdir(), `mozi-onboarding-provider-${Date.now()}`);
    mkdirSync(localMoziHome, { recursive: true });
    moziHomeBackup = process.env.MOZI_HOME;
    openAiKeyBackup = process.env.OPENAI_API_KEY;
    process.env.MOZI_HOME = localMoziHome;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    endSession(chatId);
    teardownTestDb(dbTmpDir);
    if (moziHomeBackup === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = moziHomeBackup;
    if (openAiKeyBackup === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = openAiKeyBackup;
    rmSync(localMoziHome, { recursive: true, force: true });
  });

  it('persists pasted provider keys from chat onboarding into secret storage', async () => {
    const masterKey = generateMasterKey();
    const session = startSession(chatId);
    session.step = 'no_providers';
    const fakeKey = ['sk', 'test-openai-key-123456'].join('-');

    const reply = await processOnboardingMessage(chatId, fakeKey);

    expect(reply).toContain('OpenAI API key set (OPENAI_API_KEY)');
    expect(getSession(chatId)?.step).toBe('detect_providers');
    expect(process.env.OPENAI_API_KEY).toBe(fakeKey);
    expect(readEnvVar('OPENAI_API_KEY')).toBe(null);
    expect(readPersistedSecret('OPENAI_API_KEY')).toBe(fakeKey);
    expect(getSecret('OPENAI_API_KEY', masterKey)).toBe(fakeKey);
  });
});

describe.skip('onboarding custom provider flow', () => {
  // TODO: Custom provider interactive flow handler not yet ported from branch
  const chatId = 'test-chat-custom';

  afterEach(() => {
    endSession(chatId);
  });

  it('typing "custom" in select_brain starts custom provider flow', async () => {
    const session = startSession(chatId);
    session.step = 'select_brain';
    session.providers = [{ id: 'openai', name: 'OpenAI', apiKey: 'key', models: [], healthy: true }];

    const response = await processOnboardingMessage(chatId, 'custom');
    expect(response).toContain('Custom OpenAI-Compatible Provider');
    expect(response).toContain('Groq');
    expect(response).toContain('Ollama');

    const updated = getSession(chatId);
    expect(updated?.step).toBe('custom_provider_url');
  });

  it('entering a preset number selects that preset', async () => {
    const session = startSession(chatId);
    session.step = 'custom_provider_url';
    session.pendingCustomProvider = {};
    session.providers = [];

    // Select preset 4 (Ollama) — no API key needed
    const response = await processOnboardingMessage(chatId, '4');
    expect(response).toContain('Ollama');
    expect(response).toContain('model ID');

    const updated = getSession(chatId);
    expect(updated?.step).toBe('custom_provider_model');
    expect(updated?.pendingCustomProvider?.baseUrl).toBe('http://localhost:11434/v1');
  });

  it('entering a URL moves to key step', async () => {
    const session = startSession(chatId);
    session.step = 'custom_provider_url';
    session.pendingCustomProvider = {};

    const response = await processOnboardingMessage(chatId, 'https://my-api.example.com/v1');
    expect(response).toContain('API key');

    const updated = getSession(chatId);
    expect(updated?.step).toBe('custom_provider_key');
    expect(updated?.pendingCustomProvider?.baseUrl).toBe('https://my-api.example.com/v1');
  });

  it('rejects invalid URL', async () => {
    const session = startSession(chatId);
    session.step = 'custom_provider_url';
    session.pendingCustomProvider = {};

    const response = await processOnboardingMessage(chatId, 'not-a-url');
    expect(response).toContain('valid URL');
    expect(getSession(chatId)?.step).toBe('custom_provider_url');
  });

  it('entering API key moves to model step', async () => {
    const session = startSession(chatId);
    session.step = 'custom_provider_key';
    session.pendingCustomProvider = { baseUrl: 'https://api.example.com/v1' };

    const response = await processOnboardingMessage(chatId, 'sk-test-key-123');
    expect(response).toContain('model ID');

    const updated = getSession(chatId);
    expect(updated?.step).toBe('custom_provider_model');
    expect(updated?.pendingCustomProvider?.apiKey).toBe('sk-test-key-123');
  });

  it('"skip" sets empty API key', async () => {
    const session = startSession(chatId);
    session.step = 'custom_provider_key';
    session.pendingCustomProvider = { baseUrl: 'http://localhost:11434/v1' };

    const response = await processOnboardingMessage(chatId, 'skip');
    expect(getSession(chatId)?.pendingCustomProvider?.apiKey).toBe('');
  });
});
