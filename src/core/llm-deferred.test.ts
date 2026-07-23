import { describe, expect, it } from 'vitest';
import { BrainNotConfiguredError, createDeferredClient, type LLMClient } from './llm.js';

function stubClient(): LLMClient {
  return {
    provider: 'stub',
    chat: async () => ({ content: 'ok', tool_calls: [], usage: { input_tokens: 1, output_tokens: 1 } }) as never,
    chatStream: async function* () {} as never,
  };
}

describe('createDeferredClient', () => {
  it('throws a typed BrainNotConfiguredError while unconfigured', async () => {
    const client = createDeferredClient(() => null);
    expect(client.provider).toBe('unconfigured');
    await expect(client.chat([], undefined)).rejects.toBeInstanceOf(BrainNotConfiguredError);
    await expect(client.chat([], undefined)).rejects.toMatchObject({ code: 'brain_not_configured' });
  });

  it('re-resolves on each call so onboarding activates without restart', async () => {
    let configured: LLMClient | null = null;
    const client = createDeferredClient(() => configured);

    await expect(client.chat([], undefined)).rejects.toBeInstanceOf(BrainNotConfiguredError);

    configured = stubClient();
    const response = await client.chat([], undefined);
    expect(response.content).toBe('ok');
    expect(client.provider).toBe('stub');
  });

  it('caches the resolved client after first success', async () => {
    let resolveCount = 0;
    const real = stubClient();
    const client = createDeferredClient(() => {
      resolveCount += 1;
      return real;
    });
    await client.chat([], undefined);
    await client.chat([], undefined);
    expect(resolveCount).toBe(1);
  });
});
