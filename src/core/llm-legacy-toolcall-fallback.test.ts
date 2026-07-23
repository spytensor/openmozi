import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText, streamText } from 'ai';
import type { StreamChunk, ToolDefinition } from './llm.js';
import { createAIAdapter } from './llm.js';

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

const TOOL_DEFS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search web',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          max_results: { type: 'number' },
        },
      },
    },
  },
];

async function collect(stream: AsyncGenerator<StreamChunk>): Promise<StreamChunk | null> {
  let done: StreamChunk | null = null;
  for await (const chunk of stream) {
    if (chunk.type === 'done') done = chunk;
  }
  return done;
}

describe('core/llm legacy tool-call fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves OpenAI turn-context ordering and forwards a stable prompt cache key', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'ok',
      usage: { inputTokens: 10, outputTokens: 2 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);
    const client = createAIAdapter('openai', 'gpt-test', () => ({} as never));

    await client.chat([
      { role: 'system', content: 'stable prefix' },
      { role: 'assistant', content: 'history' },
      { role: 'system', content: 'volatile turn context' },
      { role: 'user', content: 'current request' },
    ], { promptCacheKey: 'stable-key' });

    const options = vi.mocked(generateText).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.messages).toEqual([
      { role: 'system', content: 'stable prefix' },
      { role: 'assistant', content: 'history' },
      { role: 'system', content: 'volatile turn context' },
      { role: 'user', content: 'current request' },
    ]);
    expect(options.providerOptions).toEqual({ openai: { promptCacheKey: 'stable-key' } });
  });

  it('parses [TOOL_CALL] text protocol in non-stream response', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '[TOOL_CALL] {tool => "web_search", args => { --query "OPENCLAW use cases" --max_results 2 }} [/TOOL_CALL]',
      usage: { inputTokens: 18, outputTokens: 9 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'research' }], { tools: TOOL_DEFS });

    expect(response.tool_calls?.length).toBe(1);
    expect(response.tool_calls?.[0].function.name).toBe('web_search');
    const args = JSON.parse(response.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.query).toBe('OPENCLAW use cases');
    expect(args.max_results).toBe(2);
    expect(response.content).toBe('');
  });

  it('parses [TOOL_CALL] text protocol in stream done response', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: 'text-delta',
          text: 'Plan\\n[TOOL_CALL] {tool => "web_search", args => { --query "Claude Code MCP" }} [/TOOL_CALL]',
        };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 12, outputTokens: 6 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const done = await collect(client.chatStream([{ role: 'user', content: 'stream' }], { tools: TOOL_DEFS }));

    expect(done?.response?.tool_calls?.length).toBe(1);
    expect(done?.response?.tool_calls?.[0].function.name).toBe('web_search');
    const args = JSON.parse(done?.response?.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.query).toBe('Claude Code MCP');
    expect(done?.response?.content).toContain('Plan');
  });

  it('parses <function=name>{json}</function> format (Groq/DeepSeek)', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'I will search for that.\n<function=web_search>{"query": "latest news", "max_results": 5}</function>',
      usage: { inputTokens: 20, outputTokens: 12 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'search' }], { tools: TOOL_DEFS });

    expect(response.tool_calls?.length).toBe(1);
    expect(response.tool_calls?.[0].function.name).toBe('web_search');
    const args = JSON.parse(response.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.query).toBe('latest news');
    expect(args.max_results).toBe(5);
    expect(response.content).toContain('I will search');
    expect(response.content).not.toContain('<function=');
  });

  it('parses markdown code block with tool call JSON', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'Let me run that.\n```json\n{"tool": "web_search", "arguments": {"query": "test query"}}\n```',
      usage: { inputTokens: 15, outputTokens: 10 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'run' }], { tools: TOOL_DEFS });

    expect(response.tool_calls?.length).toBe(1);
    expect(response.tool_calls?.[0].function.name).toBe('web_search');
    const args = JSON.parse(response.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.query).toBe('test query');
    expect(response.content).toContain('Let me run');
    expect(response.content).not.toContain('```');
  });

  it('extracts multiple tool calls from mixed formats in same response', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '<function=web_search>{"query":"first"}</function>\nMiddle text\n[TOOL_CALL] {"tool":"web_search","arguments":{"query":"second"}} [/TOOL_CALL]',
      usage: { inputTokens: 25, outputTokens: 15 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'multi' }], { tools: TOOL_DEFS });

    expect(response.tool_calls?.length).toBe(2);
    const args0 = JSON.parse(response.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    const args1 = JSON.parse(response.tool_calls?.[1].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args0.query).toBe('first');
    expect(args1.query).toBe('second');
  });

  it('does not extract tool calls from regular JSON code blocks', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'Here is an example:\n```json\n{"users": [{"id": 1, "email": "a@b.com"}]}\n```',
      usage: { inputTokens: 12, outputTokens: 8 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'example' }], { tools: TOOL_DEFS });

    expect(response.tool_calls).toBeUndefined();
    expect(response.content).toContain('```json');
  });

  it('parses <function=name> format in stream done response', async () => {
    vi.mocked(streamText).mockReturnValue({
      fullStream: (async function* () {
        yield {
          type: 'text-delta',
          text: 'Searching now.\n<function=web_search>{"query": "stream test"}</function>',
        };
      })(),
      toolCalls: Promise.resolve([]),
      usage: Promise.resolve({ inputTokens: 14, outputTokens: 8 }),
      finishReason: Promise.resolve('stop'),
    } as never);

    const client = makeClient();
    const done = await collect(client.chatStream([{ role: 'user', content: 'stream fn' }], { tools: TOOL_DEFS }));

    expect(done?.response?.tool_calls?.length).toBe(1);
    expect(done?.response?.tool_calls?.[0].function.name).toBe('web_search');
    const args = JSON.parse(done?.response?.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.query).toBe('stream test');
    expect(done?.response?.content).toContain('Searching now');
  });

  it('does not parse legacy markers when tools are disabled for the call', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '[TOOL_CALL] {tool => "web_search", args => { --query "raw" }} [/TOOL_CALL]',
      usage: { inputTokens: 8, outputTokens: 4 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'no tools' }]);

    expect(response.tool_calls).toBeUndefined();
    expect(response.content).toContain('[TOOL_CALL]');
  });

  // Production regression (2026-07-08): a self-heal recovery call (text-only,
  // no tools) got a DSML shell_exec attempt from DeepSeek — with DOUBLED
  // fullwidth pipes (｜｜). The stripped "tool call ignored" notice was
  // delivered to the user as the final answer while the command never ran.
  // Text-only calls must treat DSML markup as an EMPTY response so the
  // recovery loop retries instead of shipping the notice.
  const DOUBLED_PIPE_DSML =
    '<｜｜DSML｜｜tool_calls>\n' +
    '<｜｜DSML｜｜invoke name="shell_exec">\n' +
    '<｜｜DSML｜｜parameter name="command" string="true">cd /data/output && python3 build_tax_template.py</｜｜DSML｜｜parameter>\n' +
    '</｜｜DSML｜｜invoke>\n' +
    '</｜｜DSML｜｜tool_calls>';

  it('treats DSML markup in a text-only call as an empty response (no fake notice)', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: DOUBLED_PIPE_DSML,
      usage: { inputTokens: 30, outputTokens: 20 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'recovery: answer directly' }]);

    expect(response.tool_calls).toBeUndefined();
    expect(response.content).toBe('');
  });

  it('recovers doubled-fullwidth-pipe DSML into a real tool call when tools are enabled', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: `继续执行。${DOUBLED_PIPE_DSML}`,
      usage: { inputTokens: 30, outputTokens: 20 },
      finishReason: 'stop',
      toolCalls: [],
    } as never);

    const client = makeClient();
    const response = await client.chat([{ role: 'user', content: 'run it' }], { tools: TOOL_DEFS });

    expect(response.tool_calls?.length).toBe(1);
    expect(response.tool_calls?.[0].function.name).toBe('shell_exec');
    const args = JSON.parse(response.tool_calls?.[0].function.arguments ?? '{}') as Record<string, unknown>;
    expect(args.command).toBe('cd /data/output && python3 build_tax_template.py');
    expect(response.content).toBe('继续执行。');
  });
});
