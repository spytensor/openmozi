import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const directClient = {
    provider: 'mock-provider',
    chat: vi.fn(),
    chatStream: vi.fn(),
    getAIModel: vi.fn(() => ({ modelId: 'mock-model' })),
  };
  const createMock = vi.fn(() => directClient);
  return {
    directClient,
    createMock,
  };
});

vi.mock('./llm.js', async () => {
  const actual = await vi.importActual<typeof import('./llm.js')>('./llm.js');
  return {
    ...actual,
    create: hoisted.createMock,
  };
});

import { clearCache, getClient, setFailoverManager } from './model-router.js';

describe('core/model-router failover wrapping', () => {
  afterEach(() => {
    clearCache();
    setFailoverManager(null as unknown as { chat: typeof hoisted.directClient.chat });
    hoisted.createMock.mockClear();
  });

  it('hides direct getAIModel access when failover manager is active', () => {
    const failoverChat = vi.fn();
    setFailoverManager({ chat: failoverChat });

    const client = getClient({
      provider: 'mock-provider',
      model: 'mock-model',
      role: 'brain',
    });

    expect(client.chat).not.toBe(hoisted.directClient.chat);
    expect(client.getAIModel).toBeUndefined();
  });
});
