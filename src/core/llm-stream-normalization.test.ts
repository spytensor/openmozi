import { beforeEach, describe, expect, it, vi } from 'vitest';
import { streamText } from 'ai';
import type { StreamChunk, ToolDefinition } from './llm.js';
import { createAIAdapter, IncompleteStreamError } from './llm.js';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
  };
});

function makeClient() {
  return createAIAdapter('mock', 'mock-model', () => ({} as never));
}

const SHELL_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'shell_exec',
    description: 'Execute shell',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
};

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<{ text: string; done: StreamChunk | null }> {
  let text = '';
  let done: StreamChunk | null = null;

  for await (const chunk of stream) {
    if (chunk.type === 'text' && chunk.text) {
      text += chunk.text;
    }
    if (chunk.type === 'done') {
      done = chunk;
    }
  }

  return { text, done };
}

describe('core/llm streaming normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads text-delta from AI SDK v6 `text` field', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Hello' };
        yield { type: 'text-delta', text: ' world' };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 12, outputTokens: 8 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream([{ role: 'user', content: 'hi' }]));

    expect(text).toBe('Hello world');
    expect(done?.type).toBe('done');
    expect(done?.response?.content).toBe('Hello world');
  });

  it('ignores empty/invalid deltas and never appends `undefined`', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: undefined };
        yield { type: 'text-delta', text: 'ok' };
        yield { type: 'text-delta', text: undefined };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 3, outputTokens: 2 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream([{ role: 'user', content: 'test' }]));

    expect(text).toBe('ok');
    expect(done?.response?.content).toBe('ok');
    expect(done?.response?.content.includes('undefined')).toBe(false);
  });

  it('deduplicates repeated text-delta chunks when delta id repeats', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'delta-1', text: 'Hi' };
        yield { type: 'text-delta', id: 'delta-1', text: 'Hi' }; // duplicate event
        yield { type: 'text-delta', id: 'delta-2', text: '!' };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 7, outputTokens: 3 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream([{ role: 'user', content: 'dup' }]));

    expect(text).toBe('Hi!');
    expect(done?.response?.content).toBe('Hi!');
  });

  it('keeps text events that arrive after finish marker and before terminal end', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'A' };
        yield { type: 'finish' };
        yield { type: 'text-delta', text: 'B' }; // should be kept
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream([{ role: 'user', content: 'late' }]));

    expect(text).toBe('AB');
    expect(done?.response?.content).toBe('AB');
  });

  it('supports providers that reuse the same delta id for cumulative snapshots', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'delta-1', text: '我' };
        yield { type: 'text-delta', id: 'delta-1', text: '我在' };
        yield { type: 'text-delta', id: 'delta-1', text: '我在这' };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 4, outputTokens: 3 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream([{ role: 'user', content: 'same-id-cumulative' }]));

    expect(text).toBe('我在这');
    expect(done?.response?.content).toBe('我在这');
  });

  it('supports providers that reuse the same delta id for incremental chunks', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', id: 'delta-1', text: '我' };
        yield { type: 'text-delta', id: 'delta-1', text: '在' };
        yield { type: 'text-delta', id: 'delta-1', text: '这里' };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 5, outputTokens: 3 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream([{ role: 'user', content: 'same-id-incremental' }]));

    expect(text).toBe('我在这里');
    expect(done?.response?.content).toBe('我在这里');
  });

  it('throws when the stream carries only an error part (e.g. auth failure)', async () => {
    // Regression: MiniMax auth errors arrived as an `error` part — the loop
    // ignored it and returned an empty response as success, so the user saw
    // a turn that "flashed" and ended with no message and no error.
    const authError = Object.assign(new Error('invalid api key'), { name: 'AI_APICallError' });
    const noOutput = Object.assign(new Error('No output generated.'), { cause: authError });
    const rejected = <T,>(reason: unknown): Promise<T> => {
      const p = Promise.reject(reason);
      p.catch(() => {});
      return p as Promise<T>;
    };
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'error', error: authError };
      })(),
      toolCalls: rejected(noOutput),
      usage: rejected(noOutput),
      finishReason: rejected(noOutput),
      reasoningText: rejected(noOutput),
    } as never);

    const client = makeClient();
    await expect(collect(client.chatStream([{ role: 'user', content: 'hi' }])))
      .rejects.toThrow('invalid api key');
  });

  it('throws the underlying cause when the stream is empty and all result promises reject', async () => {
    const authError = Object.assign(new Error('invalid api key'), { name: 'AI_APICallError' });
    const noOutput = Object.assign(new Error('No output generated.'), { cause: authError });
    const rejected = <T,>(reason: unknown): Promise<T> => {
      const p = Promise.reject(reason);
      p.catch(() => {});
      return p as Promise<T>;
    };
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {})(), // no parts at all, not even an error part
      toolCalls: rejected(noOutput),
      usage: rejected(noOutput),
      finishReason: rejected(noOutput),
      reasoningText: rejected(noOutput),
    } as never);

    const client = makeClient();
    await expect(collect(client.chatStream([{ role: 'user', content: 'hi' }])))
      .rejects.toThrow('invalid api key');
  });

  it('wraps an error part after partial text as IncompleteStreamError keeping the partial', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'partial ' };
        yield { type: 'error', error: new Error('connection reset') };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 3, outputTokens: 1 }),
      finishReason: Promise.resolve(null),
    } as never);

    const client = makeClient();
    let thrown: unknown;
    try {
      await collect(client.chatStream([{ role: 'user', content: 'hi' }]));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(IncompleteStreamError);
    expect((thrown as IncompleteStreamError).partialResponse).toMatchObject({
      content: 'partial ',
      incomplete: true,
      incomplete_reason: 'connection reset',
    });
  });

  it('throws upstream stream errors when no output was produced', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        throw new Error('invalid x-api-key');
      })(),
      toolCalls: Promise.reject(new Error('no steps')),
      usage: Promise.reject(new Error('no steps')),
      finishReason: Promise.reject(new Error('no steps')),
    } as never);

    const client = makeClient();
    await expect(collect(client.chatStream([{ role: 'user', content: 'auth check' }]))).rejects.toThrow('invalid x-api-key');
  });

  it('marks partial streamed output incomplete instead of returning a silent final response', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'partial ' };
        yield { type: 'text-delta', text: 'answer' };
        throw new Error('upstream reset');
      })(),
      toolCalls: Promise.reject(new Error('no steps')),
      usage: Promise.resolve({ inputTokens: 13, outputTokens: 2 }),
      finishReason: Promise.reject(new Error('no steps')),
    } as never);

    const client = makeClient();
    let text = '';
    let done: StreamChunk | null = null;
    let thrown: unknown;

    try {
      for await (const chunk of client.chatStream([{ role: 'user', content: 'partial check' }])) {
        if (chunk.type === 'text') text += chunk.text;
        if (chunk.type === 'done') done = chunk;
      }
    } catch (err) {
      thrown = err;
    }

    expect(text).toBe('partial answer');
    expect(done).toBeNull();
    expect(thrown).toBeInstanceOf(IncompleteStreamError);
    expect((thrown as IncompleteStreamError).partialResponse).toMatchObject({
      content: 'partial answer',
      incomplete: true,
      truncated: true,
      incomplete_reason: 'upstream reset',
      usage: { input_tokens: 13, output_tokens: 2 },
      usage_status: 'reported',
    });
  });

  it('consolidates system messages before streaming', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'ok' };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 3, outputTokens: 1 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    await collect(client.chatStream([
      { role: 'system', content: 'base policy' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'late hint' },
    ]));

    const call = vi.mocked(streamText).mock.calls[0]?.[0] as { messages?: Array<{ role: string; content: string }> };
    expect(call.messages?.map(message => message.role)).toEqual(['system', 'user']);
    expect(call.messages?.[0].content).toContain('base policy');
    expect(call.messages?.[0].content).toContain('late hint');
  });

  it('surfaces AI SDK tool input streaming events', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'tool-input-start', id: 'call-1', toolName: 'create_artifact' };
        yield { type: 'tool-input-delta', id: 'call-1', delta: '{"title":"Live' };
        yield { type: 'tool-input-delta', id: 'call-1', delta: ' Report"}' };
        yield { type: 'tool-input-end', id: 'call-1' };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 8, outputTokens: 4 }),
      finishReason: Promise.resolve('tool-calls'),
    } as never);

    const client = makeClient();
    const chunks: StreamChunk[] = [];
    for await (const chunk of client.chatStream([{ role: 'user', content: 'make a report' }])) {
      chunks.push(chunk);
    }

    expect(chunks.slice(0, 4)).toEqual([
      { type: 'tool_input_start', toolCallId: 'call-1', toolName: 'create_artifact' },
      { type: 'tool_input_delta', toolCallId: 'call-1', delta: '{"title":"Live' },
      { type: 'tool_input_delta', toolCallId: 'call-1', delta: ' Report"}' },
      { type: 'tool_input_end', toolCallId: 'call-1' },
    ]);
    expect(chunks.at(-1)?.type).toBe('done');
  });

  it('parses complete DSML tool-call text into real tool calls without streaming raw markup', async () => {
    const leaked =
      '<|DSML|tool_calls>' +
      '<|DSML|invoke name="shell_exec">' +
      '<|DSML|parameter name="command" string="true">python build_mozi_deck.py</|DSML|parameter>' +
      '</|DSML|invoke>' +
      '</|DSML|tool_calls>';
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Working. ' };
        yield { type: 'text-delta', text: leaked.slice(0, 60) };
        yield { type: 'text-delta', text: leaked.slice(60) };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 9 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream(
      [{ role: 'user', content: 'make a deck' }],
      { tools: [SHELL_TOOL] },
    ));

    expect(text).toBe('Working. ');
    expect(text).not.toContain('<|DSML|');
    expect(done?.response?.content).toBe('Working.');
    expect(done?.response?.tool_calls).toHaveLength(1);
    expect(done?.response?.tool_calls?.[0].function.name).toBe('shell_exec');
    const args = JSON.parse(done?.response?.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.command).toBe('python build_mozi_deck.py');
  });

  it('strips malformed DeepSeek DSML opening tokens and surfaces an ignored-tool-call note', async () => {
    const leaked =
      '<|DSML|tool_calls> <|DSML|invoke name="shell_exec"> ' +
      '<|DSML|parameter name="command" string="true">python build_mozi_deck.py';
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield { type: 'text-delta', text: 'Working. ' };
        yield { type: 'text-delta', text: leaked };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 10, outputTokens: 8 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const { text, done } = await collect(client.chatStream(
      [{ role: 'user', content: 'make a deck' }],
      { tools: [SHELL_TOOL] },
    ));

    expect(text).toBe('Working. ');
    expect(text).not.toContain('<|DSML|');
    expect(done?.response?.tool_calls).toBeUndefined();
    expect(done?.response?.content).not.toContain('<|DSML|');
    expect(done?.response?.content).toContain('模型返回了无法解析的工具调用');
    expect(done?.response?.content).toContain('The model emitted an unparsable tool call; it was ignored.');
  });
});
