import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VectorStore, type MemoryDocument } from './vector-store.js';
import type { EmbeddingProvider } from './embeddings.js';

/**
 * Mock embedding provider that returns deterministic vectors.
 * Uses simple hash-based vectors for reproducible tests.
 */
class MockEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 8;
  readonly providerName = 'mock';
  readonly modelName = 'mock-embed';

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(text => this.hashToVector(text));
  }

  private hashToVector(text: string): number[] {
    const vec = new Array(this.dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % this.dimensions] += text.charCodeAt(i) / 1000;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map(v => v / norm);
  }
}

describe('VectorStore', () => {
  let tmpDir: string;
  let store: VectorStore;
  let provider: MockEmbeddingProvider;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mozi-vec-test-'));
    provider = new MockEmbeddingProvider();
    store = new VectorStore(join(tmpDir, 'test.lance'), provider);
  });

  afterEach(async () => {
    await store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore cleanup errors */ }
  });

  const DOC1: MemoryDocument = {
    id: 'fact-1',
    text: 'User prefers Python for data analysis',
    category: 'preference',
    key: 'language_preference',
    createdAt: Date.now(),
  };

  const DOC2: MemoryDocument = {
    id: 'fact-2',
    text: 'User works at a fintech startup in Shanghai',
    category: 'fact',
    key: 'workplace',
    createdAt: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
  };

  const DOC3: MemoryDocument = {
    id: 'fact-3',
    text: 'User prefers dark mode in all IDEs',
    category: 'preference',
    key: 'ide_preference',
    createdAt: Date.now(),
  };

  it('upserts documents and counts them', async () => {
    await store.upsert([DOC1, DOC2, DOC3]);
    const count = await store.count();
    expect(count).toBe(3);
  });

  it('deletes documents by id', async () => {
    await store.upsert([DOC1, DOC2, DOC3]);
    await store.delete([DOC2.id]);
    expect(await store.count()).toBe(2);
    const results = await store.searchVector(DOC2.text, 5);
    expect(results.some(result => result.id === DOC2.id)).toBe(false);
  });

  it('searches by vector similarity', async () => {
    await store.upsert([DOC1, DOC2, DOC3]);
    const results = await store.searchVector('Python programming', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('vector');
    expect(results[0].score).toBeGreaterThan(0);
  });

  it('searches with hybrid mode', async () => {
    await store.upsert([DOC1, DOC2, DOC3]);
    const results = await store.searchHybrid('data analysis', {
      topK: 3,
      vectorWeight: 0.7,
      keywordWeight: 0.3,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe('hybrid');
  });

  it('boosts multi-character Chinese words without boosting a shared single Han character', async () => {
    const relevant: MemoryDocument = {
      id: 'cjk-relevant',
      text: '报告格式已经确认',
      category: 'fact',
      createdAt: Date.now(),
    };
    const noisy: MemoryDocument = {
      id: 'cjk-noisy',
      text: '报税材料已经确认',
      category: 'fact',
      createdAt: Date.now(),
    };
    await store.upsert([relevant, noisy]);

    const results = await store.searchHybrid('报告', {
      topK: 2,
      vectorWeight: 0,
      keywordWeight: 1,
      temporalDecay: false,
    });

    expect(results.find(result => result.id === 'cjk-relevant')?.score).toBe(1);
    expect(results.find(result => result.id === 'cjk-noisy')?.score).toBe(0);
  });

  it('applies temporal decay to older documents', async () => {
    const recentDoc: MemoryDocument = {
      id: 'recent',
      text: 'This is recent information about testing',
      category: 'fact',
      createdAt: Date.now(),
    };
    const oldDoc: MemoryDocument = {
      id: 'old',
      text: 'This is old information about testing',
      category: 'fact',
      createdAt: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year ago
    };

    await store.upsert([recentDoc, oldDoc]);
    const results = await store.searchHybrid('testing information', {
      topK: 2,
      temporalDecay: true,
      decayHalfLifeDays: 30,
    });

    // Recent doc should score higher due to temporal decay
    expect(results.length).toBe(2);
    const recentResult = results.find(r => r.id === 'recent');
    const oldResult = results.find(r => r.id === 'old');
    expect(recentResult).toBeDefined();
    expect(oldResult).toBeDefined();
    expect(recentResult!.score).toBeGreaterThan(oldResult!.score);
  });

  it('handles empty upsert', async () => {
    await store.upsert([]);
    const count = await store.count();
    expect(count).toBe(0);
  });

  it('returns empty results for empty store', async () => {
    const count = await store.count();
    expect(count).toBe(0);
  });
});
