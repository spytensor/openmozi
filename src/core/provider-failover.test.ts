import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as providerHealth from './provider-health.js';
import { getState as getRateLimitState } from './rate-limiter.js';
import { createFailoverManager, type FallbackChain } from './provider-failover.js';
import type { ChatResponse, StreamChunk } from './llm.js';

// Mock the LLM create function
vi.mock('./llm.js', () => {
  return {
    create: vi.fn((provider: string, options: { model?: string } = {}) => {
      return {
        provider,
        chat: vi.fn(),
        chatStream: vi.fn(),
      };
    }),
  };
});

const configHoisted = vi.hoisted(() => ({
  rateLimits: {} as Record<string, { rpm: number; tpm: number; concurrent: number }>,
}));

// Mock config
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    brain: {
      model: 'claude-opus-4',
      fallback_model: 'claude-sonnet-4',
      max_dag_depth: 5,
    },
    rate_limits: configHoisted.rateLimits,
  }),
}));

import { create } from './llm.js';
const mockedCreate = vi.mocked(create);

function makeChain(): FallbackChain {
  return {
    primary: { provider: 'anthropic', model: 'claude-opus-4' },
    fallbacks: [
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      { provider: 'openai', model: 'gpt-4.1-mini' },
    ],
  };
}

function makeResponse(content: string, model: string): ChatResponse {
  return {
    content,
    usage: { input_tokens: 10, output_tokens: 5 },
    model,
    stop_reason: 'end_turn',
  };
}

describe('core/provider-failover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configHoisted.rateLimits = {};
    providerHealth.reset('anthropic');
    providerHealth.reset('openai');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts in normal mode', () => {
    const fm = createFailoverManager(makeChain());
    const state = fm.getState();
    expect(state.mode).toBe('normal');
    expect(state.activeProvider).toBe('anthropic');
    expect(state.queueLength).toBe(0);
    fm.destroy();
  });

  it('successful chat returns response and stays normal', async () => {
    const fm = createFailoverManager(makeChain());

    mockedCreate.mockReturnValue({
      provider: 'anthropic',
      chat: vi.fn().mockResolvedValue({
        content: 'Hello!',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-opus-4',
        stop_reason: 'end_turn',
      }),
      chatStream: vi.fn(),
    });

    const response = await fm.chat([{ role: 'user', content: 'hi' }]);
    expect(response.content).toBe('Hello!');
    expect(fm.getState().mode).toBe('normal');

    fm.destroy();
  });

  it('does not switch providers inside a pinned tool-loop session', async () => {
    const fm = createFailoverManager(makeChain());
    let primaryCalls = 0;
    let fallbackCalls = 0;
    mockedCreate.mockImplementation((provider: string, options: { model?: string } = {}) => ({
      provider,
      chat: vi.fn().mockImplementation(async () => {
        if (provider === 'anthropic' && options.model === 'claude-opus-4') {
          primaryCalls++;
          if (primaryCalls === 1) return makeResponse('tool call turn', 'claude-opus-4');
          throw new Error('429 rate limit reached');
        }
        fallbackCalls++;
        return makeResponse('fallback', options.model ?? 'fallback');
      }),
      chatStream: vi.fn(),
    }));

    const options = { failoverSessionKey: 'task-attempt-1' };
    await expect(fm.chat([{ role: 'user', content: 'start' }], options)).resolves.toMatchObject({ model: 'claude-opus-4' });
    await expect(fm.chat([{ role: 'user', content: 'continue' }], options)).rejects.toThrow('rate limit');
    expect(fallbackCalls).toBe(0);
    fm.destroy();
  });

  it('applies a process-wide OpenAI safety budget when config has no explicit limit', async () => {
    const fm = createFailoverManager(makeChain());
    const before = getRateLimitState('openai')?.requestsThisMinute ?? 0;
    mockedCreate.mockImplementation((provider: string, options: { model?: string } = {}) => ({
      provider,
      chat: vi.fn().mockResolvedValue(makeResponse('ok', options.model ?? '')),
      chatStream: vi.fn(),
    }));

    await fm.chat([{ role: 'user', content: 'research' }], {
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });

    const state = getRateLimitState('openai');
    expect(state).not.toBeNull();
    expect(state!.requestsThisMinute).toBe(before + 1);
    expect(state!.concurrent).toBe(0);
    fm.destroy();
  });

  it('cancels saturated provider admission without a late provider call', async () => {
    const provider = 'queued-provider-abort';
    configHoisted.rateLimits = {
      [provider]: { rpm: 100, tpm: 100000, concurrent: 1 },
    };
    const fm = createFailoverManager({
      primary: { provider, model: 'queued-model' },
      fallbacks: [],
    });
    let finishFirst!: (response: ChatResponse) => void;
    const chat = vi.fn()
      .mockImplementationOnce(() => new Promise<ChatResponse>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(makeResponse('late call', 'queued-model'));
    mockedCreate.mockReturnValue({ provider, chat, chatStream: vi.fn() });

    const first = fm.chat([{ role: 'user', content: 'occupy the only slot' }]);
    await vi.waitFor(() => expect(getRateLimitState(provider)?.concurrent).toBe(1));

    const controller = new AbortController();
    const queued = fm.chat(
      [{ role: 'user', content: 'must never reach the provider' }],
      { abort_signal: controller.signal },
    );
    await vi.waitFor(() => expect(getRateLimitState(provider)?.queueLength).toBe(1));
    controller.abort(new Error('gateway deadline exceeded'));

    await expect(queued).rejects.toMatchObject({ name: 'AbortError', message: 'gateway deadline exceeded' });
    expect(getRateLimitState(provider)?.queueLength).toBe(0);
    finishFirst(makeResponse('first complete', 'queued-model'));
    await expect(first).resolves.toMatchObject({ content: 'first complete' });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(chat).toHaveBeenCalledTimes(1);
    expect(getRateLimitState(provider)?.concurrent).toBe(0);
    fm.destroy();
  });

  it('cancels saturated streaming admission before starting a zombie stream', async () => {
    const provider = 'queued-stream-provider-abort';
    configHoisted.rateLimits = {
      [provider]: { rpm: 100, tpm: 100000, concurrent: 1 },
    };
    const fm = createFailoverManager({
      primary: { provider, model: 'queued-stream-model' },
      fallbacks: [],
    });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });
    const chatStream = vi.fn(async function* () {
      await firstGate;
    });
    mockedCreate.mockReturnValue({ provider, chat: vi.fn(), chatStream });

    const firstIterator = fm.chatStream([{ role: 'user', content: 'occupy the only stream slot' }]);
    const firstNext = firstIterator.next();
    await vi.waitFor(() => expect(getRateLimitState(provider)?.concurrent).toBe(1));

    const controller = new AbortController();
    const queuedIterator = fm.chatStream(
      [{ role: 'user', content: 'must never start a provider stream' }],
      { abort_signal: controller.signal },
    );
    const queuedNext = queuedIterator.next();
    await vi.waitFor(() => expect(getRateLimitState(provider)?.queueLength).toBe(1));
    controller.abort(new Error('stream gateway deadline exceeded'));

    await expect(queuedNext).rejects.toMatchObject({ name: 'AbortError', message: 'stream gateway deadline exceeded' });
    expect(getRateLimitState(provider)?.queueLength).toBe(0);
    finishFirst();
    await expect(firstNext).resolves.toMatchObject({ done: true });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(chatStream).toHaveBeenCalledTimes(1);
    expect(getRateLimitState(provider)?.concurrent).toBe(0);
    fm.destroy();
  });

  it('records failure in provider health on chat error', async () => {
    const fm = createFailoverManager(makeChain());

    // All providers fail
    mockedCreate.mockReturnValue({
      provider: 'anthropic',
      chat: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
      chatStream: vi.fn(),
    });

    await expect(fm.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow();
    fm.destroy();
  });

  it('enters fallback mode when primary fails', async () => {
    const fm = createFailoverManager(makeChain());
    let callCount = 0;

    mockedCreate.mockImplementation((provider: string) => ({
      provider,
      chat: vi.fn().mockImplementation(async () => {
        callCount++;
        if (provider === 'anthropic' && callCount <= 2) {
          throw new Error('Provider down');
        }
        return {
          content: 'Fallback response',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: 'gpt-4.1-mini',
          stop_reason: 'end_turn',
        };
      }),
      chatStream: vi.fn(),
    }));

    // Force primary to be "down" in health
    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('anthropic');

    const response = await fm.chat([{ role: 'user', content: 'hi' }]);
    expect(response.content).toBe('Fallback response');

    fm.destroy();
  });

  it('filters fallback candidates through the caller effective model set', async () => {
    const fm = createFailoverManager(makeChain());
    const created: Array<{ provider: string; model?: string }> = [];

    mockedCreate.mockImplementation((provider: string, options: { model?: string } = {}) => {
      created.push({ provider, model: options.model });
      return {
        provider,
        chat: vi.fn().mockResolvedValue({
          content: 'Allowed fallback response',
          usage: { input_tokens: 10, output_tokens: 5 },
          model: options.model ?? '',
          stop_reason: 'end_turn',
        }),
        chatStream: vi.fn(),
      };
    });

    const response = await fm.chat([{ role: 'user', content: 'hi' }], {
      entitlements: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        allowedModels: ['gpt-4.1-mini'],
      },
    });

    expect(response.content).toBe('Allowed fallback response');
    expect(created).toEqual([{ provider: 'openai', model: 'gpt-4.1-mini' }]);
    fm.destroy();
  });

  it('honors caller-selected provider/model and retries that provider before brain primary', async () => {
    const fm = createFailoverManager({
      primary: { provider: 'anthropic', model: 'claude-opus-4' },
      fallbacks: [
        { provider: 'openai', model: 'gpt-4.1-mini' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ],
    });
    const calls: Array<{ provider: string; createModel?: string; callModel?: string }> = [];
    let openaiAttempts = 0;

    mockedCreate.mockImplementation((provider: string, options: { model?: string } = {}) => ({
      provider,
      chat: vi.fn().mockImplementation(async (_messages, chatOptions?: { model?: string }) => {
        calls.push({ provider, createModel: options.model, callModel: chatOptions?.model });
        if (provider === 'openai') {
          openaiAttempts++;
          if (openaiAttempts === 1) {
            throw new Error('transient selected provider failure');
          }
          return makeResponse('Selected model response', chatOptions?.model ?? '');
        }
        return makeResponse('Brain primary response', chatOptions?.model ?? '');
      }),
      chatStream: vi.fn(),
    }));

    const response = await fm.chat([{ role: 'user', content: 'hi' }], {
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });

    expect(response.content).toBe('Selected model response');
    expect(calls).toEqual([
      { provider: 'openai', createModel: 'gpt-4.1-mini', callModel: 'gpt-4.1-mini' },
      { provider: 'openai', createModel: 'gpt-4.1-mini', callModel: 'gpt-4.1-mini' },
    ]);
    fm.destroy();
  });

  it('does not retry the same provider after a non-retryable structured quota failure', async () => {
    const fm = createFailoverManager({
      primary: { provider: 'anthropic', model: 'claude-opus-4' },
      fallbacks: [
        { provider: 'openai', model: 'gpt-4.1-mini' },
        { provider: 'openai', model: 'gpt-4o-mini' },
      ],
    });
    const calls: string[] = [];

    mockedCreate.mockImplementation((provider: string, options: { model?: string } = {}) => ({
      provider,
      chat: vi.fn().mockImplementation(async () => {
        calls.push(provider);
        if (provider === 'openai') {
          throw {
            type: 'error',
            error: {
              type: 'insufficient_quota',
              code: 'insufficient_quota',
              message: 'You exceeded your current quota, please check your plan and billing details.',
            },
          };
        }
        return makeResponse('Fallback response', options.model ?? '');
      }),
      chatStream: vi.fn(),
    }));

    const response = await fm.chat([{ role: 'user', content: 'hi' }], {
      provider: 'openai',
      model: 'gpt-4.1-mini',
    });

    expect(response.content).toBe('Fallback response');
    expect(calls).toEqual(['openai', 'anthropic']);
    fm.destroy();
  });

  it('chatStream retries a secondary provider when the primary stream throws', async () => {
    const fm = createFailoverManager({
      primary: { provider: 'anthropic', model: 'claude-opus-4' },
      fallbacks: [
        { provider: 'openai', model: 'gpt-4.1-mini' },
      ],
    });
    const calls: Array<{ provider: string; model?: string }> = [];

    mockedCreate.mockImplementation((provider: string) => ({
      provider,
      chat: vi.fn(),
      chatStream: async function* (_messages, options?: { model?: string }): AsyncGenerator<StreamChunk> {
        calls.push({ provider, model: options?.model });
        if (provider === 'anthropic') {
          throw new Error('primary stream failed');
        }
        yield { type: 'text', text: 'fallback stream' };
        yield { type: 'done', response: makeResponse('fallback stream', options?.model ?? '') };
      },
    }));

    const chunks: StreamChunk[] = [];
    for await (const chunk of fm.chatStream([{ role: 'user', content: 'hi' }])) {
      chunks.push(chunk);
    }

    expect(calls).toEqual([
      { provider: 'anthropic', model: 'claude-opus-4' },
      { provider: 'openai', model: 'gpt-4.1-mini' },
    ]);
    expect(chunks).toEqual([
      { type: 'text', text: 'fallback stream' },
      { type: 'done', response: makeResponse('fallback stream', 'gpt-4.1-mini') },
    ]);
    fm.destroy();
  });

  it('skips a known-down primary when already in fallback mode', async () => {
    const fm = createFailoverManager({
      primary: { provider: 'anthropic', model: 'claude-opus-4' },
      fallbacks: [
        { provider: 'openai', model: 'gpt-4.1-mini' },
      ],
    });
    const calls: Array<{ provider: string; model?: string }> = [];

    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('anthropic');
    fm.setMode('fallback', 'Primary was down');

    mockedCreate.mockImplementation((provider: string, options: { model?: string } = {}) => ({
      provider,
      chat: vi.fn().mockImplementation(async (_messages, chatOptions?: { model?: string }) => {
        calls.push({ provider, model: chatOptions?.model });
        return makeResponse('Fallback response', chatOptions?.model ?? options.model ?? '');
      }),
      chatStream: vi.fn(),
    }));

    const response = await fm.chat([{ role: 'user', content: 'hi' }]);

    expect(response.content).toBe('Fallback response');
    expect(calls).toEqual([{ provider: 'openai', model: 'gpt-4.1-mini' }]);
    fm.destroy();
  });

  it('enters degraded mode when all providers are down', () => {
    const fm = createFailoverManager(makeChain());

    // Simulate all providers going down
    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('anthropic');
    providerHealth.reportFailure('openai');
    providerHealth.reportFailure('openai');
    providerHealth.reportFailure('openai');

    fm.setMode('degraded', 'All providers down');
    expect(fm.getState().mode).toBe('degraded');

    fm.destroy();
  });

  it('queues complex requests in degraded mode', async () => {
    const fm = createFailoverManager(makeChain());
    fm.setMode('degraded', 'test');

    // Complex request should be queued
    const promise = fm.chat(
      [{ role: 'user', content: 'complex task' }],
      { isComplex: true },
    );

    // Give a tick for the queue to process
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fm.getQueueLength()).toBe(1);

    fm.destroy();
    // Promise should be rejected when manager is destroyed
    await expect(promise).rejects.toThrow('Failover manager destroyed');
  });

  it('applies backpressure by rejecting new requests when degraded queue is full', async () => {
    const fm = createFailoverManager(makeChain(), {
      maxQueueLength: 1,
      fullQueuePolicy: 'reject_new',
    });
    fm.setMode('degraded', 'test');

    const p1 = fm.chat([{ role: 'user', content: 'task 1' }], { isComplex: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fm.getQueueLength()).toBe(1);

    await expect(
      fm.chat([{ role: 'user', content: 'task 2' }], { isComplex: true }),
    ).rejects.toThrow('Degraded queue full');

    expect(fm.getQueueLength()).toBe(1);
    fm.destroy();
    await expect(p1).rejects.toThrow('destroyed');
  });

  it('drops oldest request when queue is full and policy is drop_oldest', async () => {
    const fm = createFailoverManager(makeChain(), {
      maxQueueLength: 1,
      fullQueuePolicy: 'drop_oldest',
    });
    fm.setMode('degraded', 'test');

    const p1 = fm.chat([{ role: 'user', content: 'task 1' }], { isComplex: true });
    const p1Handled = p1.catch((err) => err);
    await new Promise(resolve => setTimeout(resolve, 10));
    const p2 = fm.chat([{ role: 'user', content: 'task 2' }], { isComplex: true });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(fm.getQueueLength()).toBe(1);
    const dropped = await p1Handled;
    expect(dropped).toBeInstanceOf(Error);
    expect((dropped as Error).message).toContain('dropped oldest');

    fm.destroy();
    await expect(p2).rejects.toThrow('destroyed');
  });

  it('rejects expired queued requests when leaving degraded mode', async () => {
    const fm = createFailoverManager(makeChain(), {
      requestTtlMs: 5,
    });
    fm.setMode('degraded', 'test');

    const queued = fm.chat([{ role: 'user', content: 'ttl task' }], { isComplex: true });
    await new Promise(resolve => setTimeout(resolve, 20));

    fm.setMode('normal', 'recovered');
    await expect(queued).rejects.toThrow('expired');
    fm.destroy();
  });

  it('mode change callback is called', () => {
    const fm = createFailoverManager(makeChain());
    const callbacks: Array<{ mode: string; message: string }> = [];
    fm.onModeChange((mode, message) => {
      callbacks.push({ mode, message });
    });

    fm.setMode('degraded', 'test');
    expect(callbacks).toHaveLength(1);
    expect(callbacks[0].mode).toBe('degraded');
    expect(callbacks[0].message).toContain('degraded');

    fm.setMode('normal', 'recovered');
    expect(callbacks).toHaveLength(2);
    expect(callbacks[1].mode).toBe('normal');

    fm.destroy();
  });

  it('setMode is idempotent (same mode = no callback)', () => {
    const fm = createFailoverManager(makeChain());
    const callbacks: string[] = [];
    fm.onModeChange((mode) => callbacks.push(mode));

    fm.setMode('degraded', 'test');
    fm.setMode('degraded', 'test again');
    expect(callbacks).toHaveLength(1);

    fm.destroy();
  });

  it('destroy rejects queued requests', async () => {
    const fm = createFailoverManager(makeChain());
    fm.setMode('degraded', 'test');

    const p1 = fm.chat([{ role: 'user', content: 'task 1' }], { isComplex: true });
    const p2 = fm.chat([{ role: 'user', content: 'task 2' }], { isComplex: true });

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fm.getQueueLength()).toBe(2);

    fm.destroy();

    await expect(p1).rejects.toThrow('destroyed');
    await expect(p2).rejects.toThrow('destroyed');
  });

  it('recovery back to normal after primary succeeds', async () => {
    const fm = createFailoverManager(makeChain());

    // Start in fallback mode
    fm.setMode('fallback', 'Primary was down');

    // Primary comes back
    mockedCreate.mockReturnValue({
      provider: 'anthropic',
      chat: vi.fn().mockResolvedValue({
        content: 'Back!',
        usage: { input_tokens: 10, output_tokens: 5 },
        model: 'claude-opus-4',
        stop_reason: 'end_turn',
      }),
      chatStream: vi.fn(),
    });

    const response = await fm.chat([{ role: 'user', content: 'hi' }]);
    expect(response.content).toBe('Back!');
    expect(fm.getState().mode).toBe('normal');

    fm.destroy();
  });

  it('getState returns snapshot of current state', () => {
    const fm = createFailoverManager(makeChain());
    const state = fm.getState();

    expect(state.mode).toBe('normal');
    expect(state.activeProvider).toBe('anthropic');
    expect(state.activeModel).toBe('claude-opus-4');
    expect(state.queueLength).toBe(0);
    expect(typeof state.lastModeChange).toBe('number');

    fm.destroy();
  });
});
