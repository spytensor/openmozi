import { describe, it, expect, afterEach } from 'vitest';
import { loadConfig, type MoziConfig } from '../config/index.js';
import {
  resetMemoryEmbeddingProviderForTests,
  resolveMemoryEmbeddingProvider,
} from './embedding-provider.js';

function baseConfig(): MoziConfig {
  return structuredClone(loadConfig('/nonexistent/mozi.json'));
}

describe('memory/embedding-provider', () => {
  afterEach(() => {
    resetMemoryEmbeddingProviderForTests();
  });

  it('returns null when no embedding config or env is present', () => {
    const config = baseConfig();
    const resolution = resolveMemoryEmbeddingProvider(config, {}, 'test-no-provider');
    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toBe('no_embedding_provider_configured');
  });

  it('honors explicit provider config before env auto-detection', () => {
    const config = baseConfig();
    config.memory.embedding = {
      provider: 'ollama',
      base_url: 'http://ollama.test:11434',
      model: 'nomic-test',
      dimensions: 128,
    };

    const resolution = resolveMemoryEmbeddingProvider(config, {
      OPENAI_API_KEY: 'sk-openai-env',
    });

    expect(resolution.provider?.providerName).toBe('ollama');
    expect(resolution.provider?.modelName).toBe('nomic-test');
    expect(resolution.provider?.dimensions).toBe(128);
  });

  it('selects OpenAI first in auto mode when an OpenAI key is configured', () => {
    const config = baseConfig();
    const resolution = resolveMemoryEmbeddingProvider(config, {
      OPENAI_API_KEY: 'sk-openai-env',
      OLLAMA_BASE_URL: 'http://ollama.test:11434',
      MINIMAX_API_KEY: 'minimax-env',
    });

    expect(resolution.provider?.providerName).toBe('openai');
    expect(resolution.provider?.modelName).toBe('text-embedding-3-small');
  });

  it('selects Ollama in auto mode when an Ollama URL is configured', () => {
    const config = baseConfig();
    const resolution = resolveMemoryEmbeddingProvider(config, {
      OLLAMA_BASE_URL: 'http://ollama.test:11434',
      MINIMAX_API_KEY: 'minimax-env',
    }, 'test-ollama-only');

    expect(resolution.provider?.providerName).toBe('ollama');
    expect(resolution.provider?.modelName).toBe('nomic-embed-text');
  });

  it('does not treat MiniMax chat credentials as an embedding capability in auto mode', () => {
    const config = baseConfig();
    const resolution = resolveMemoryEmbeddingProvider(config, {
      MINIMAX_API_KEY: 'minimax-env',
    }, 'test-minimax-only');

    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toBe('no_embedding_provider_configured');
  });

  it('supports explicit disabled mode', () => {
    const config = baseConfig();
    config.memory.embedding = { provider: 'none' };

    const resolution = resolveMemoryEmbeddingProvider(config, {
      OPENAI_API_KEY: 'sk-openai-env',
    });

    expect(resolution.provider).toBeNull();
    expect(resolution.reason).toBe('disabled_by_config');
  });
});
