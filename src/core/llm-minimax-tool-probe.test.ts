/** Real-provider smoke for the weak-tool-use profile. Skips explicitly without MINIMAX_API_KEY. */
import { describe, expect, it } from 'vitest';
import { create, type ChatMessage, type ToolDefinition } from './llm.js';

const LOOKUP_TOOL: ToolDefinition[] = [{
  type: 'function',
  function: {
    name: 'lookup_temperature',
    description: 'Return the current temperature for a city',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
      additionalProperties: false,
    },
  },
}];

const hasKey = Boolean(process.env.MINIMAX_API_KEY?.trim());

describe.skipIf(!hasKey)('PROBE MiniMax Chinese tool continuation', () => {
  it('calls one relevant tool and grounds the final answer in its result', async () => {
    const client = create('minimax', { model: 'MiniMax-M3' });
    const messages: ChatMessage[] = [{
      role: 'user',
      content: '请使用工具查询迪拜当前温度，不要猜测。',
    }];
    const first = await client.chat(messages, {
      tools: LOOKUP_TOOL,
      max_tokens: 1000,
      temperature: 0,
    });
    expect(first.tool_calls?.length).toBe(1);
    messages.push({
      role: 'assistant',
      content: first.content,
      reasoning_content: first.reasoning_content,
      tool_calls: first.tool_calls,
    });
    messages.push({
      role: 'tool',
      content: '41 C',
      tool_call_id: first.tool_calls![0].id,
      tool_name: 'lookup_temperature',
    });
    const final = await client.chat(messages, {
      tools: LOOKUP_TOOL,
      max_tokens: 1000,
      temperature: 0,
    });
    expect(final.content).toContain('41');
  }, 180_000);
});
