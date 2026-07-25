import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createModelFactory } from './model-factory.js';

afterEach(() => vi.unstubAllGlobals());

describe('Azure OpenAI model factory', () => {
  it('rejects missing resource URL or API version before creating a model', () => {
    expect(() => createModelFactory({
      providerId: 'azure',
      apiMode: 'azure-openai',
      apiKey: 'secret',
      baseUrl: '',
      apiVersion: '2024-10-21',
    })).toThrow('Azure OpenAI base URL is required');
    expect(() => createModelFactory({
      providerId: 'azure',
      apiMode: 'azure-openai',
      apiKey: 'secret',
      baseUrl: 'https://resource.openai.azure.com',
    })).toThrow('Azure OpenAI API version is required');
  });

  it('uses the deployment route, api-version, and api-key without Bearer auth', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-test',
      created: 1,
      model: 'ignored-by-azure',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const factory = createModelFactory({
      providerId: 'azure',
      apiMode: 'azure-openai',
      apiKey: 'azure-secret',
      baseUrl: 'https://resource.openai.azure.com/',
      apiVersion: '2024-10-21',
    });
    await generateText({ model: factory('custom deployment'), prompt: 'hello' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0]!;
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(url.pathname).toBe('/openai/deployments/custom%20deployment/chat/completions');
    expect(url.searchParams.get('api-version')).toBe('2024-10-21');
    expect(headers.get('api-key')).toBe('azure-secret');
    expect(headers.has('authorization')).toBe(false);
  });

  it('reduces a pasted portal endpoint to the resource root instead of duplicating the path', async () => {
    // The portal shows the full target URI, so operators paste it verbatim.
    // Appending to it 404s, and when it already ends in /chat/completions the
    // SDK folds the appended path into the query string — every request then
    // silently hits the pasted deployment rather than the selected model.
    for (const pasted of [
      'https://resource.openai.azure.com/openai',
      'https://resource.openai.azure.com/openai/deployments/other-deployment',
      'https://resource.openai.azure.com/openai/deployments/other/chat/completions?api-version=2023-05-15',
    ]) {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
        id: 'chatcmpl-test',
        created: 1,
        model: 'ignored-by-azure',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', fetchMock);

      const factory = createModelFactory({
        providerId: 'azure',
        apiMode: 'azure-openai',
        apiKey: 'azure-secret',
        baseUrl: pasted,
        apiVersion: '2024-10-21',
      });
      await generateText({ model: factory('gpt-4o'), prompt: 'hello' });

      const url = new URL(String(fetchMock.mock.calls[0]![0]));
      expect(url.host, pasted).toBe('resource.openai.azure.com');
      expect(url.pathname, pasted).toBe('/openai/deployments/gpt-4o/chat/completions');
      expect(url.searchParams.get('api-version'), pasted).toBe('2024-10-21');
      vi.unstubAllGlobals();
    }
  });
});
