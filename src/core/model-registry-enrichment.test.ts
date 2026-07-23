import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearModelRegistryEnrichmentCache, enrich } from './model-registry-enrichment.js';

let moziHome: string;
let savedMoziHome: string | undefined;

beforeEach(() => {
  savedMoziHome = process.env.MOZI_HOME;
  moziHome = join(tmpdir(), `mozi-litellm-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  process.env.MOZI_HOME = moziHome;
  clearModelRegistryEnrichmentCache();
});

afterEach(() => {
  clearModelRegistryEnrichmentCache();
  vi.unstubAllGlobals();
  rmSync(moziHome, { recursive: true, force: true });
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
});

describe('model registry enrichment', () => {
  it('uses the 24h memory cache after the first registry fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        'gpt-5.5-pro': {
          max_input_tokens: 400000,
          max_output_tokens: 32768,
          supports_function_calling: true,
          supports_vision: true,
          input_cost_per_token: 0.000002,
          output_cost_per_token: 0.000008,
          cache_read_input_token_cost: 0.0000002,
          cache_creation_input_token_cost: 0.0000025,
          litellm_provider: 'openai',
        },
      }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(enrich('openai', 'gpt-5.5-pro')).resolves.toMatchObject({
      contextWindow: 400000,
      maxOutputTokens: 32768,
      supportsTools: true,
      supportsVision: true,
      inputCostPer1M: 2,
      outputCostPer1M: 8,
      provider: 'openai',
      cacheWriteCostPer1M: 2.5,
    });
    expect((await enrich('openai', 'gpt-5.5-pro'))?.cacheReadCostPer1M).toBeCloseTo(0.2);
    await expect(enrich('openai', 'gpt-5.5-pro')).resolves.toMatchObject({ contextWindow: 400000 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the disk cache when the network registry is unavailable', async () => {
    const cacheDir = join(moziHome, 'data', 'cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'litellm-registry.json'), JSON.stringify({
      'deepseek/deepseek-v4-pro-preview': {
        max_input_tokens: 1048576,
        supports_function_calling: true,
      },
    }), 'utf-8');
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')));

    await expect(enrich('deepseek', 'deepseek-v4-pro-preview')).resolves.toEqual({
      contextWindow: 1048576,
      supportsTools: true,
    });
  });

  it('returns null when a model is absent from the registry', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ 'gpt-5.5': { max_input_tokens: 400000 } }),
    } as Response));

    await expect(enrich('openai', 'not-a-registry-model')).resolves.toBeNull();
  });
});
