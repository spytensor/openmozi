import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProvider } from './providers.js';
import { clearModelDiscoveryCache, discoverProviderModels, isSafeCustomModelId } from './model-discovery.js';

afterEach(() => clearModelDiscoveryCache());

describe('provider model discovery', () => {
  it('discovers OpenAI-compatible models and falls back to stale cache', async () => {
    const provider = getProvider('deepseek')!;
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ id: 'deepseek-new' }, { id: 'text-embedding-3-large' }] }),
    } as Response).mockRejectedValueOnce(new Error('offline'));
    const first = await discoverProviderModels({ provider, baseUrl: provider.baseUrl, apiKey: 'secret', tenantId: 't1', force: true, fetchImpl, now: 1000 });
    const stale = await discoverProviderModels({ provider, baseUrl: provider.baseUrl, apiKey: 'secret', tenantId: 't1', force: true, fetchImpl, now: 2000 });
    expect(first).toMatchObject({ source: 'live', models: [{ id: 'deepseek-new' }] });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error' });
    expect(stale).toMatchObject({ source: 'cache', fallbackReason: 'offline', models: [{ id: 'deepseek-new' }] });
  });

  it('uses Google and Ollama native list protocols', async () => {
    const googleFetch = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ models: [
      { name: 'models/gemini-next', displayName: 'Gemini Next', inputTokenLimit: 200000, supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding', supportedGenerationMethods: ['embedContent'] },
    ] }) } as Response);
    const google = await discoverProviderModels({ provider: getProvider('google')!, baseUrl: '', apiKey: 'secret', tenantId: 't', fetchImpl: googleFetch });
    expect(String(googleFetch.mock.calls[0]?.[0])).toContain('/v1beta/models?pageSize=1000');
    expect(google.models).toEqual([expect.objectContaining({ id: 'gemini-next', name: 'Gemini Next', contextWindow: 200000 })]);

    const ollamaFetch = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: async () => ({ models: [{ model: 'llama-new:latest' }] }) } as Response);
    const ollama = await discoverProviderModels({ provider: getProvider('ollama')!, baseUrl: 'http://localhost:11434', tenantId: 't', fetchImpl: ollamaFetch });
    expect(String(ollamaFetch.mock.calls[0]?.[0])).toBe('http://localhost:11434/api/tags');
    expect(ollama.models[0]?.id).toBe('llama-new:latest');
  });

  it('accepts bounded model ids and rejects unsafe manual values', () => {
    expect(isSafeCustomModelId('vendor/model-v2:free')).toBe(true);
    expect(isSafeCustomModelId('../model')).toBe(false);
    expect(isSafeCustomModelId('model id')).toBe(false);
  });
});
