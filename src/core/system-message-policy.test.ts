import { describe, it, expect } from 'vitest';
import { consolidateSystemMessages, toCoreMessages } from './ai-sdk-adapter.js';
import { getAllProviders, resolveSystemMessagePolicy } from './providers.js';
import type { ChatMessage } from './llm-contracts.js';

/**
 * Cache-prefix regression tests (2026-07 incident).
 *
 * Root cause: consolidateSystemMessages hoisted every system message into one
 * leading block for all providers except literal 'openai'. Once the execution
 * kernel started appending a system-role tool-truth directive after every tool
 * batch (#727), each LLM call in a loop rewrote the request head, so DeepSeek's
 * automatic prefix cache only ever matched the system block — hit rate fell
 * from 91.4% to ~22-33% overnight. These tests pin the fix: verified providers
 * preserve interleaved system messages, so request N is a strict prefix of
 * request N+1 within a tool loop.
 */

describe('resolveSystemMessagePolicy', () => {
  it('resolves the verified first wave to their probed layouts', () => {
    // DeepSeek's server mishandles mid-array system in tool loops (cache dies
    // at the head), so it keeps positions but demotes mid-array system → user.
    expect(resolveSystemMessagePolicy('deepseek')).toBe('interleaved-as-user');
    expect(resolveSystemMessagePolicy('openai')).toBe('preserve-interleaved');
    expect(resolveSystemMessagePolicy('openai-codex')).toBe('preserve-interleaved');
  });

  it('consolidates for unverified, unknown, and custom endpoints', () => {
    // Protocol compatibility does not imply mid-conversation system support:
    // Qwen/DashScope is OpenAI-compatible yet requires system at messages[0].
    expect(resolveSystemMessagePolicy('moonshot')).toBe('consolidate-leading');
    expect(resolveSystemMessagePolicy('zhipu')).toBe('consolidate-leading');
    expect(resolveSystemMessagePolicy('some-custom-endpoint')).toBe('consolidate-leading');
    expect(resolveSystemMessagePolicy(undefined)).toBe('consolidate-leading');
  });

  it('always consolidates outside OpenAI-family API modes — a catalog typo must not ship a 400', () => {
    // anthropic (minimax rides it), bedrock, google, ollama-native, cli-pipe:
    // none of these have a verified in-array system contract, and the pinned
    // @ai-sdk/anthropic outright rejects split system blocks.
    const openAiFamily = new Set(['openai-responses', 'openai-codex-responses', 'openai-compat']);
    const otherTransports = getAllProviders().filter(def => !openAiFamily.has(def.apiMode));
    expect(otherTransports.length).toBeGreaterThan(0);
    for (const def of otherTransports) {
      expect(resolveSystemMessagePolicy(def.id)).toBe('consolidate-leading');
    }
  });

  it('no catalog entry declares a non-consolidating policy outside OpenAI-family API modes', () => {
    const openAiFamily = new Set(['openai-responses', 'openai-codex-responses', 'openai-compat']);
    const misconfigured = getAllProviders().filter(
      def => !openAiFamily.has(def.apiMode)
        && def.systemMessagePolicy !== undefined
        && def.systemMessagePolicy !== 'consolidate-leading',
    );
    expect(misconfigured).toEqual([]);
  });
});

describe('consolidateSystemMessages', () => {
  const interleaved: ChatMessage[] = [
    { role: 'system', content: 'SOUL + tools' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'system', content: '[Turn Context] epoch_ms=1' },
    { role: 'user', content: 'current question' },
  ];

  it('consolidate-leading merges every system message into one leading block, non-system order intact', () => {
    const result = consolidateSystemMessages(toCoreMessages(interleaved), 'consolidate-leading');
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('SOUL + tools\n\n---\n\n[Turn Context] epoch_ms=1');
    expect(result.slice(1).map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(result.filter(m => m.role === 'system')).toHaveLength(1);
  });

  it('preserve-interleaved leaves the sequence byte-identical', () => {
    const core = toCoreMessages(interleaved);
    const result = consolidateSystemMessages(core, 'preserve-interleaved');
    expect(result).toBe(core); // same array — nothing rewritten, nothing moved
  });

  it('defaults to consolidation when no policy is given — conservative for unmigrated callers', () => {
    const result = consolidateSystemMessages(toCoreMessages(interleaved));
    expect(result.filter(m => m.role === 'system')).toHaveLength(1);
  });

  it('interleaved-as-user keeps positions, keeps the leading block, demotes only mid-array system', () => {
    const withLeadingBlock: ChatMessage[] = [
      { role: 'system', content: 'SOUL' },
      { role: 'system', content: 'AGENTS' }, // consecutive leading systems stay system
      ...interleaved.slice(1),
    ];
    const result = consolidateSystemMessages(toCoreMessages(withLeadingBlock), 'interleaved-as-user');
    expect(result.map(m => m.role)).toEqual(['system', 'system', 'user', 'assistant', 'user', 'user']);
    // The demoted message keeps its position and exact content.
    expect(result[4]).toEqual({ role: 'user', content: '[Turn Context] epoch_ms=1' });
  });
});

describe('tool-loop cache prefix invariant', () => {
  /** The real loop shape: turn context after history, then loop appends. */
  const iterationOne: ChatMessage[] = [
    { role: 'system', content: 'SOUL + AGENTS + tools' },
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'system', content: '[Turn Context] epoch_ms=1784473629029' },
    { role: 'user', content: '生成一份报告' },
  ];
  const iterationTwo: ChatMessage[] = [
    ...iterationOne,
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }],
    },
    { role: 'tool', content: 'file contents', tool_call_id: 'call_1', tool_name: 'read_file' },
    // The kernel's tool-truth directive — the mid-loop system message that
    // triggered the incident once it got hoisted to the head.
    { role: 'system', content: '[RUNTIME INTERJECTION:kernel_directive] tool outcomes: ok' },
  ];

  function payload(messages: ChatMessage[], policy: 'preserve-interleaved' | 'interleaved-as-user' | 'consolidate-leading') {
    return consolidateSystemMessages(toCoreMessages(messages), policy).map(m => JSON.stringify(m));
  }

  it('preserve-interleaved: request N is a strict prefix of request N+1', () => {
    const first = payload(iterationOne, 'preserve-interleaved');
    const second = payload(iterationTwo, 'preserve-interleaved');
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.slice(0, first.length)).toEqual(first);
  });

  it('interleaved-as-user: the prefix invariant holds too — demotion is per-message and deterministic', () => {
    const first = payload(iterationOne, 'interleaved-as-user');
    const second = payload(iterationTwo, 'interleaved-as-user');
    expect(second.length).toBeGreaterThan(first.length);
    expect(second.slice(0, first.length)).toEqual(first);
    // And no system role survives past the leading block — DeepSeek's cache killer.
    expect(second.slice(1).some(m => JSON.parse(m).role === 'system')).toBe(false);
  });

  it('consolidate-leading breaks the prefix at the head — why unverified providers pay with cache misses', () => {
    const first = payload(iterationOne, 'consolidate-leading');
    const second = payload(iterationTwo, 'consolidate-leading');
    // The kernel directive lands inside the merged head, so even the first
    // message differs and nothing before the history can be reused as-is.
    expect(second[0]).not.toEqual(first[0]);
  });
});
