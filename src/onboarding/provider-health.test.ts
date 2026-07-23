import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderInfo } from './index.js';

const chatMock = vi.fn();
const createMock = vi.fn(() => ({
  chat: chatMock,
}));

vi.mock('../core/llm.js', () => ({
  create: (...args: unknown[]) => createMock(...args),
}));

function makeProvider(): ProviderInfo {
  return {
    id: 'minimax',
    name: 'MiniMax',
    apiKey: 'test-key',
    baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    models: [{ id: 'MiniMax-M2.5', name: 'MiniMax M2.5', provider: 'minimax' }],
    healthy: false,
  };
}

describe('onboarding/checkProviderHealth', () => {
  beforeEach(() => {
    chatMock.mockReset();
    createMock.mockClear();
  });

  it('treats successful roundtrip as healthy even when text is empty', async () => {
    chatMock.mockResolvedValue({
      content: '',
      usage: { input_tokens: 42, output_tokens: 0 },
      model: 'MiniMax-M2.5',
      stop_reason: 'max_tokens',
    });

    const { checkProviderHealth } = await import('./index.js');
    const ok = await checkProviderHealth(makeProvider());

    expect(ok).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when provider call throws', async () => {
    chatMock.mockRejectedValue(new Error('invalid api key'));

    const { checkProviderHealth } = await import('./index.js');
    const ok = await checkProviderHealth(makeProvider());

    expect(ok).toBe(false);
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});
