import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider, type EmbeddingConfig } from './embeddings.js';

describe('embeddings', () => {
  describe('createEmbeddingProvider', () => {
    it('returns null for provider "none"', () => {
      expect(createEmbeddingProvider({ provider: 'none' })).toBeNull();
    });

    it('returns null for unknown provider', () => {
      expect(createEmbeddingProvider({ provider: 'unknown' as any })).toBeNull();
    });

    it('creates OpenAI provider with API key', () => {
      const original = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      try {
        const provider = createEmbeddingProvider({ provider: 'openai' });
        expect(provider).not.toBeNull();
        expect(provider!.providerName).toBe('openai');
        expect(provider!.modelName).toBe('text-embedding-3-small');
        expect(provider!.dimensions).toBe(1536);
      } finally {
        if (original) process.env.OPENAI_API_KEY = original;
        else delete process.env.OPENAI_API_KEY;
      }
    });

    it('throws for OpenAI without API key', () => {
      const original = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      try {
        expect(() => createEmbeddingProvider({ provider: 'openai' })).toThrow('OPENAI_API_KEY');
      } finally {
        if (original) process.env.OPENAI_API_KEY = original;
      }
    });

    it('creates Ollama provider without API key', () => {
      const provider = createEmbeddingProvider({ provider: 'ollama' });
      expect(provider).not.toBeNull();
      expect(provider!.providerName).toBe('ollama');
      expect(provider!.modelName).toBe('nomic-embed-text');
      expect(provider!.dimensions).toBe(768);
    });

    it('respects custom model and dimensions', () => {
      const provider = createEmbeddingProvider({
        provider: 'ollama',
        model: 'custom-model',
        dimensions: 512,
      });
      expect(provider!.modelName).toBe('custom-model');
      expect(provider!.dimensions).toBe(512);
    });
  });
});
