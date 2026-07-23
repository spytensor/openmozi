/**
 * Real-API guard for DeepSeek's interleaved-directive contract (the basis for
 * systemMessagePolicy: 'interleaved-as-user' on the deepseek provider).
 *
 * The exact shape under test is what a MOZI tool loop sends after #727:
 *
 *   system(stable) → user → assistant(tool_calls) → tool → system(kernel directive) → continuation
 *
 * The adapter demotes the mid-array system directive to user role for
 * DeepSeek (its server accepts mid-array system over HTTP but stops
 * prefix-cache matching at the pre-loop head once one appears — probed
 * 2026-07-20). This test locks the surviving contract: the demoted directive
 * is accepted and the continuation still reflects the runtime tool truth. If
 * it starts failing, revisit the policy in provider-catalog.ts rather than
 * silently consolidating — that would resurrect the 2026-07 cache regression.
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

describe.skipIf(!hasKey)('PROBE deepseek interleaved system after tool results', () => {
  it('accepts a kernel-style system directive between tool result and continuation', async () => {
    const client = create('deepseek', { model: 'deepseek-v4-flash' });
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are a terse assistant. Answer with numbers only when asked to compute.' },
      { role: 'user', content: 'Use the calculator tool to compute 23*47. You must call the tool.' },
    ];
    const r1 = await client.chat(messages, { tools: CALC_TOOL, max_tokens: 400, temperature: 0 });
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
    // The mid-loop system message that consolidation used to hoist to the head.
    messages.push({
      role: 'system',
      content: '[INTERNAL DIRECTIVE — not a user message] Runtime tool outcomes (ground truth):\n{"outcome":1,"tool":"calculator","status":"success"}\nWhen you reference tool results, strictly follow this runtime truth.',
    });

    const r2 = await client.chat(messages, { tools: CALC_TOOL, max_tokens: 400, temperature: 0 });
    // HTTP acceptance + a coherent continuation that reflects the tool result.
    expect(r2.content ?? '').toContain('1081');
  }, 120_000);
});
