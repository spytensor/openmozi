import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import { create, toCoreMessages, type StreamChunk } from './llm.js';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn((opts: Record<string, unknown>) => (modelId: string) => ({
    sdk: 'openai',
    opts,
    modelId,
  })),
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: vi.fn((opts: Record<string, unknown>) => (modelId: string) => ({
    sdk: 'anthropic',
    opts,
    modelId,
  })),
}));

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn((opts: Record<string, unknown>) => ({
    chatModel: (modelId: string) => ({
      sdk: 'openai-compatible',
      opts,
      modelId,
    }),
  })),
}));

async function invoke(provider: string, params: { model: string; apiKey: string; baseUrl: string }) {
  const client = create(provider, params);
  await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8 });
}

describe('core/llm adapter mode routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateText).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);
  });

  it('routes openai-responses providers to OpenAI adapter', async () => {
    await invoke('openai', {
      model: 'gpt-4.1-mini',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(createOpenAI).toHaveBeenCalledTimes(1);
    expect(createAnthropic).not.toHaveBeenCalled();
  });

  it('routes openai-codex-responses providers to OpenAI adapter', async () => {
    await invoke('openai-codex', {
      model: 'gpt-5-codex',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
    });

    expect(createOpenAI).toHaveBeenCalledTimes(1);
    expect(createOpenAICompatible).not.toHaveBeenCalled();
  });

  it('routes google-generative-ai providers through compatibility adapter', async () => {
    await invoke('google', {
      model: 'gemini-2.5-flash',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });

    expect(createOpenAICompatible).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0] as { baseURL?: string };
    expect(firstCall.baseURL).toBe('https://generativelanguage.googleapis.com/v1beta/openai/v1');
  });

  it('normalizes MiniMax official endpoints to Anthropic path', async () => {
    await invoke('minimax', {
      model: 'MiniMax-M2.5',
      apiKey: 'minimax-key',
      baseUrl: 'https://api.minimax.io/v1',
    });

    expect(createAnthropic).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(createAnthropic).mock.calls[0]?.[0] as { baseURL?: string };
    expect(firstCall.baseURL).toBe('https://api.minimax.io/anthropic/v1');
  });

  it('routes ollama-native providers to OpenAI-compatible /v1 endpoint', async () => {
    await invoke('ollama', {
      model: 'qwen3:32b',
      apiKey: 'ollama-local',
      baseUrl: 'http://localhost:11434',
    });

    expect(createOpenAICompatible).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0] as { baseURL?: string };
    expect(firstCall.baseURL).toBe('http://localhost:11434/v1');
  });

  it('routes bedrock-converse-stream providers through compatibility adapter', async () => {
    await invoke('bedrock', {
      model: 'anthropic.claude-3-5-sonnet-20241022-v2:0',
      apiKey: 'bedrock-token',
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    });

    expect(createOpenAICompatible).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0] as { baseURL?: string };
    expect(firstCall.baseURL).toBe('https://bedrock-runtime.us-east-1.amazonaws.com');
  });

  it('falls back unknown providers with baseUrl to openai-compatible mode', async () => {
    await invoke('custom-proxy', {
      model: 'custom-model',
      apiKey: 'proxy-key',
      baseUrl: 'https://proxy.example.com/v1',
    });

    expect(createOpenAICompatible).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(createOpenAICompatible).mock.calls[0]?.[0] as { name?: string; baseURL?: string };
    expect(firstCall.name).toBe('custom-proxy');
    expect(firstCall.baseURL).toBe('https://proxy.example.com/v1');
  });

  it('maps think option to OpenAI reasoningEffort provider option', async () => {
    const client = create('openai', {
      model: 'gpt-5',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: 'high' });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    expect((providerOptions.openai as Record<string, unknown>).reasoningEffort).toBe('high');
  });

  it('does not attach reasoningEffort for non-reasoning OpenAI models', async () => {
    const client = create('openai', {
      model: 'gpt-4.1',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: 'high' });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.providerOptions).toBeUndefined();
  });

  it('maps think option to Google reasoningEffort for Gemini 2.5 models', async () => {
    const client = create('google', {
      model: 'gemini-2.5-flash',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: 'high' });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    expect((providerOptions.google as Record<string, unknown>).reasoningEffort).toBe('high');
  });

  it('maps think option to Google thinking_budget for Gemini 3.x models', async () => {
    const client = create('google', {
      model: 'gemini-3.1-flash-lite-preview',
      apiKey: 'gemini-key',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: 'high' });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    const googleOptions = providerOptions.google as Record<string, unknown>;
    const extraBody = googleOptions.extra_body as Record<string, unknown>;
    const extraBodyGoogle = extraBody.google as Record<string, unknown>;
    const thinkingConfig = extraBodyGoogle.thinking_config as Record<string, unknown>;

    expect(googleOptions.reasoningEffort).toBeUndefined();
    expect(thinkingConfig.thinking_budget).toBe(4096);
  });

  it('maps DeepSeek think option to thinking and reasoning_effort provider options', async () => {
    const client = create('deepseek', {
      model: 'deepseek-v4-pro',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: 'high' });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    const deepseekOptions = providerOptions.deepseek as Record<string, unknown>;
    expect(deepseekOptions.reasoningEffort).toBe('high');
    expect(deepseekOptions.thinking).toEqual({ type: 'enabled' });
  });

  it('maps DeepSeek think=false to non-thinking mode', async () => {
    const client = create('deepseek', {
      model: 'deepseek-v4-flash',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: false });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    const deepseekOptions = providerOptions.deepseek as Record<string, unknown>;
    expect(deepseekOptions.thinking).toEqual({ type: 'disabled' });
  });

  it('keeps DeepSeek reasoning enabled for tool calls when think is not explicit', async () => {
    const client = create('deepseek', {
      model: 'deepseek-v4-pro',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
    });
    await client.chat([{ role: 'user', content: 'ping' }], {
      max_tokens: 8,
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      }],
    });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    const deepseekOptions = providerOptions.deepseek as Record<string, unknown>;
    expect(deepseekOptions.thinking).toEqual({ type: 'enabled' });
    expect(deepseekOptions.reasoningEffort).toBe('high');
  });

  it('preserves reasoning_content when converting assistant tool-call messages', () => {
    const messages = toCoreMessages([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need current date before weather lookup.',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_date', arguments: '{}' },
        }],
      },
      {
        role: 'tool',
        content: '2026-04-24',
        tool_call_id: 'call_1',
        tool_name: 'get_date',
      },
    ]);

    const assistant = messages[1] as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toContainEqual({
      type: 'reasoning',
      text: 'Need current date before weather lookup.',
    });
  });

  it('exposes provider reasoning text on chat responses', async () => {
    vi.mocked(generateText).mockResolvedValueOnce({
      text: '',
      reasoningText: 'Need a tool result first.',
      usage: { inputTokens: 2, outputTokens: 3 },
      finishReason: 'tool-calls',
      toolCalls: [{ toolCallId: 'call_1', toolName: 'get_date', input: {} }],
    } as never);

    const client = create('deepseek', {
      model: 'deepseek-v4-pro',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
    });
    const response = await client.chat([{ role: 'user', content: 'weather?' }], { max_tokens: 8 });

    expect(response.reasoning_content).toBe('Need a tool result first.');
    expect(response.tool_calls?.[0].id).toBe('call_1');
  });

  it('preserves streamed reasoning deltas when returning tool calls', async () => {
    vi.mocked(streamText).mockReturnValueOnce({
      fullStream: (async function* () {
        yield { type: 'reasoning-delta', id: 'reasoning-0', delta: 'Need a tool.' };
      })(),
      toolCalls: Promise.resolve([{ toolCallId: 'call_1', toolName: 'lookup', input: {} }]),
      usage: Promise.resolve({ inputTokens: 2, outputTokens: 3 }),
      finishReason: Promise.resolve('tool-calls'),
      reasoningText: Promise.resolve(undefined),
    } as never);

    const client = create('deepseek', {
      model: 'deepseek-v4-pro',
      apiKey: 'deepseek-key',
      baseUrl: 'https://api.deepseek.com',
    });

    const chunks: StreamChunk[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'weather?' }], {
      max_tokens: 8,
      think: 'high',
      tools: [{
        type: 'function',
        function: {
          name: 'lookup',
          description: 'Lookup',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      }],
    })) {
      chunks.push(chunk);
    }

    const done = chunks.find(chunk => chunk.type === 'done');
    expect(done?.response?.reasoning_content).toBe('Need a tool.');
    expect(done?.response?.tool_calls?.[0].id).toBe('call_1');
  });

  it('maps numeric think option to Anthropic thinking budget', async () => {
    const client = create('anthropic', {
      model: 'claude-sonnet-4-6',
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.com',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, think: 3072 });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    const providerOptions = call.providerOptions as Record<string, unknown>;
    const anthropicOptions = providerOptions.anthropic as Record<string, unknown>;
    const thinking = anthropicOptions.thinking as Record<string, unknown>;
    expect(thinking.type).toBe('enabled');
    expect(thinking.budgetTokens).toBe(3072);
  });

  it('clamps max_tokens to the provider model metadata limit', async () => {
    const client = create('together', {
      model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
      apiKey: 'together-key',
      baseUrl: 'https://api.together.xyz/v1',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 999999 });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.maxOutputTokens).toBe(4096);
  });

  it('omits temperature for reasoning models', async () => {
    const client = create('openai', {
      model: 'gpt-5.4',
      apiKey: 'openai-key',
      baseUrl: 'https://api.openai.com/v1',
    });
    await client.chat([{ role: 'user', content: 'ping' }], { max_tokens: 8, temperature: 0.4 });

    const call = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.temperature).toBeUndefined();
  });
});
