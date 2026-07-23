/**
 * Real-API guard for DeepSeek thinking + tool loops (probe-verified
 * 2026-07-08, kept as the e2e regression for enabling brain.think).
 *
 * Findings locked in:
 *  1. deepseek-v4-pro with think=true + tools returns tool calls AND
 *     reasoning_content.
 *  2. Tool continuation succeeds when reasoning_content is echoed.
 *  3. Tool continuation without it is rejected. This is a provider protocol
 *     contract, not an observational result that may silently pass.
 */
import { describe, it, expect } from 'vitest';
import { create, type ChatMessage, type ToolDefinition } from './llm.js';

const CALC_TOOL: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Multiply two integers',
      parameters: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b'],
      },
    },
  },
];

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY);

describe.skipIf(!hasKey)('PROBE deepseek-v4-pro thinking + tool loop', () => {
  it('round 1: think=true with tools returns a tool call', async () => {
    const client = create('deepseek', { model: 'deepseek-v4-pro' });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Use the calculator tool to compute 23*47. You must call the tool.' },
    ];
    const r1 = await client.chat(messages, { tools: CALC_TOOL, think: true, max_tokens: 800, temperature: 0 });
    console.log('R1 tool_calls:', JSON.stringify(r1.tool_calls));
    console.log('R1 reasoning present:', Boolean(r1.reasoning_content), 'len:', r1.reasoning_content?.length ?? 0);
    expect(r1.tool_calls?.length ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it('round 2 WITH reasoning_content echoed: continuation succeeds', async () => {
    const client = create('deepseek', { model: 'deepseek-v4-pro' });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Use the calculator tool to compute 23*47. You must call the tool.' },
    ];
    const r1 = await client.chat(messages, { tools: CALC_TOOL, think: true, max_tokens: 800, temperature: 0 });
    expect(r1.tool_calls?.length ?? 0).toBeGreaterThan(0);
    messages.push({
      role: 'assistant',
      content: r1.content || '',
      reasoning_content: r1.reasoning_content,
      tool_calls: r1.tool_calls,
    });
    messages.push({
      role: 'tool',
      content: '1081',
      tool_call_id: r1.tool_calls![0].id,
      tool_name: 'calculator',
    });
    const r2 = await client.chat(messages, { tools: CALC_TOOL, think: true, max_tokens: 800, temperature: 0 });
    console.log('R2 content:', r2.content.slice(0, 200));
    expect(r2.content).toContain('1081');
  }, 180_000);

  it('round 2 WITHOUT reasoning_content is rejected by the provider contract', async () => {
    const client = create('deepseek', { model: 'deepseek-v4-pro' });
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Use the calculator tool to compute 23*47. You must call the tool.' },
    ];
    const r1 = await client.chat(messages, { tools: CALC_TOOL, think: true, max_tokens: 800, temperature: 0 });
    expect(r1.tool_calls?.length ?? 0).toBeGreaterThan(0);
    messages.push({
      role: 'assistant',
      content: r1.content || '',
      // deliberately NO reasoning_content — mirrors today's dag-task-loop
      tool_calls: r1.tool_calls,
    });
    messages.push({
      role: 'tool',
      content: '1081',
      tool_call_id: r1.tool_calls![0].id,
      tool_name: 'calculator',
    });
    await expect(client.chat(messages, {
      tools: CALC_TOOL,
      think: true,
      max_tokens: 800,
      temperature: 0,
    })).rejects.toThrow(/reasoning_content/i);
  }, 180_000);
});
