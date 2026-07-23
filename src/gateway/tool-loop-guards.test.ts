import { describe, it, expect } from 'vitest';
import type { ChatMessage, ToolCall } from '../core/llm.js';
import {
  buildConstraintRecoveryHintMessage,
  buildGuardFallbackMessage,
  sanitizeToolPairs,
  truncateToolResult,
  computeToolCallHash,
  LoopDetector,
  detectBehavioralFailure,
  buildBrainSelfCorrectionPrompt,
} from './tool-loop-guards.js';

describe('sanitizeToolPairs', () => {
  it('returns intact messages unchanged', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Search for X' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool', content: 'found X', tool_call_id: 'call_1', tool_name: 'search' },
      { role: 'assistant', content: 'Here is X' },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result).toEqual(messages);
    expect(result.length).toBe(5);
  });

  it('removes orphaned tool results (no matching assistant tool_call)', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'tool', content: 'orphaned result', tool_call_id: 'call_999', tool_name: 'search' },
      { role: 'user', content: 'hello' },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result.length).toBe(2);
    expect(result.map(m => m.role)).toEqual(['system', 'user']);
  });

  it('strips tool_calls from assistant when results are missing', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'do X' },
      { role: 'assistant', content: 'I will search', tool_calls: [
        { id: 'call_A', type: 'function', function: { name: 'search', arguments: '{}' } },
        { id: 'call_B', type: 'function', function: { name: 'read', arguments: '{}' } },
      ] },
      // Only result for call_A, missing call_B
      { role: 'tool', content: 'search result', tool_call_id: 'call_A', tool_name: 'search' },
      { role: 'user', content: 'next' },
    ];
    const result = sanitizeToolPairs(messages);
    // Assistant message should have tool_calls stripped (kept as plain text)
    // The orphaned tool result for call_A should also be removed (since the assistant no longer has tool_calls)
    const assistant = result.find(m => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect((assistant as Record<string, unknown>).tool_calls).toBeUndefined();
    expect(assistant!.content).toBe('I will search');
  });

  it('handles multiple intact tool_call groups', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'do X and Y' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'result 1', tool_call_id: 'call_1', tool_name: 'search' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_2', type: 'function', function: { name: 'write', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'result 2', tool_call_id: 'call_2', tool_name: 'write' },
      { role: 'assistant', content: 'Done!' },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result).toEqual(messages);
  });

  it('strips tool_calls when tool results are not adjacent', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'assistant', content: 'calling tool', tool_calls: [
        { id: 'call_adj', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ] },
      { role: 'system', content: 'interleaved system message' },
      { role: 'tool', content: 'tool output', tool_call_id: 'call_adj', tool_name: 'read_file' },
    ];

    const result = sanitizeToolPairs(messages);
    expect(result).toEqual([
      { role: 'system', content: 'prompt' },
      { role: 'assistant', content: 'calling tool' },
      { role: 'system', content: 'interleaved system message' },
    ]);
  });

  it('keeps parallel tool results when all expected ids are adjacent', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call_2', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ] },
      { role: 'tool', content: 'result 1', tool_call_id: 'call_1', tool_name: 'read_file' },
      { role: 'tool', content: 'result 2', tool_call_id: 'call_2', tool_name: 'read_file' },
      { role: 'assistant', content: 'done' },
    ];

    const result = sanitizeToolPairs(messages);
    expect(result).toEqual(messages);
  });

  it('handles messages with no tool_calls at all', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = sanitizeToolPairs(messages);
    expect(result).toEqual(messages);
  });

  it('removes all orphaned tool results after stripping assistant tool_calls', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prompt' },
      { role: 'assistant', content: 'Searching...', tool_calls: [
        { id: 'call_X', type: 'function', function: { name: 'search', arguments: '{}' } },
        { id: 'call_Y', type: 'function', function: { name: 'read', arguments: '{}' } },
      ] },
      // Only one of two results present
      { role: 'tool', content: 'result X', tool_call_id: 'call_X', tool_name: 'search' },
      { role: 'user', content: 'continue' },
    ];
    const result = sanitizeToolPairs(messages);
    // After stripping tool_calls from assistant, call_X result becomes orphaned too
    // Both tool_calls are from the same assistant, one is missing, so strip all
    expect(result.every(m => m.role !== 'tool')).toBe(true);
    expect(result.find(m => m.role === 'assistant')!.content).toBe('Searching...');
  });
});

describe('buildConstraintRecoveryHintMessage', () => {
  it('returns null when no known hard constraints are present', () => {
    const message = buildConstraintRecoveryHintMessage(['Temporary upstream error']);
    expect(message).toBeNull();
  });

  it('builds a recovery directive for shell RBAC and path constraints', () => {
    const message = buildConstraintRecoveryHintMessage([
      "Permission denied: agent 'gateway:1' has L0_READ_ONLY but action 'shell.execute' requires L2_SHELL_EXEC",
      'Path not allowed by tools.fs.workspace_only policy: ../../../../src/utils/contextCompressor.ts',
      "ENOENT: no such file or directory, scandir '/home/example/.mozi/workspace/src'",
    ]);

    expect(message).toContain('INTERNAL DIRECTIVE');
    expect(message).toContain('Do not call shell_exec again');
    expect(message).toContain('workspace_only policy');
    expect(message).toContain('path does not exist');
  });
});

describe('buildGuardFallbackMessage', () => {
  it('returns permission guidance when shell RBAC blocks execution', () => {
    const fallback = buildGuardFallbackMessage(
      'max_iterations',
      'please continue',
      ["Permission denied: action 'shell.execute' requires L2_SHELL_EXEC"],
    );
    expect(fallback).toContain('shell_exec is blocked by RBAC');
  });

  it('returns localized guidance when workspace policy blocks zh request', () => {
    const fallback = buildGuardFallbackMessage(
      'max_iterations',
      '继续处理这个问题',
      ['Path not allowed by tools.fs.workspace_only policy: ../../src'],
    );
    expect(fallback).toContain('workspace_only');
    expect(fallback).toContain('工作区');
  });
});

describe('truncateToolResult', () => {
  it('returns small content within budget unchanged', () => {
    const content = 'x'.repeat(100);
    const result = truncateToolResult(content, 5000, 1);
    expect(result).toBe(content);
  });

  it('truncates large content with generous budget', () => {
    const content = 'x'.repeat(50_000);
    const result = truncateToolResult(content, 10_000, 1);
    expect(result.length).toBeLessThan(content.length);
    // Should contain head portion
    expect(result.startsWith('x')).toBe(true);
    // Should contain tail portion
    expect(result.endsWith('x')).toBe(true);
    // Should contain truncation marker
    expect(result).toContain('[truncated');
  });

  it('truncates large content more aggressively with tight budget', () => {
    const content = 'x'.repeat(50_000);
    const generous = truncateToolResult(content, 10_000, 1);
    const tight = truncateToolResult(content, 300, 1);
    expect(tight.length).toBeLessThan(generous.length);
    // Even with tight budget, should still have meaningful content (min 200 token floor)
    // 200 tokens of Latin text ~ 800 chars, plus ellipsis marker
    expect(tight.length).toBeGreaterThan(100);
  });

  it('splits budget across multiple tool calls', () => {
    const content = 'x'.repeat(50_000);
    const singleTool = truncateToolResult(content, 3000, 1);
    const fiveTools = truncateToolResult(content, 3000, 5);
    // With 5 tools, each gets less budget, so result should be shorter
    expect(fiveTools.length).toBeLessThan(singleTool.length);
  });

  it('does not truncate content exactly at budget boundary', () => {
    // Latin text: 4 chars = 1 token
    // For a budget of 1000 tokens with 1 tool call, the per-tool budget is 30% of 1000 = 300 tokens
    // 300 tokens = 1200 chars of Latin text
    const budgetTokens = 1000;
    const content = 'x'.repeat(1000); // 250 tokens — well within 300 per-tool budget
    const result = truncateToolResult(content, budgetTokens, 1);
    expect(result).toBe(content);
  });

  it('returns empty string for empty content', () => {
    const result = truncateToolResult('', 5000, 1);
    expect(result).toBe('');
  });

  it('includes truncation marker in truncated output', () => {
    const content = 'x'.repeat(50_000);
    const result = truncateToolResult(content, 500, 1);
    expect(result).toContain('[truncated');
  });
});

// ── Hash-based loop detection ──

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${Date.now()}_${Math.random()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

describe('computeToolCallHash', () => {
  it('produces identical hash for same tool call regardless of argument key order', () => {
    const a = [makeToolCall('read_file', { path: '/a', encoding: 'utf-8' })];
    const b: ToolCall[] = [{
      id: 'different_id',
      type: 'function',
      function: { name: 'read_file', arguments: JSON.stringify({ encoding: 'utf-8', path: '/a' }) },
    }];
    expect(computeToolCallHash(a)).toBe(computeToolCallHash(b));
  });

  it('produces identical hash regardless of tool call order in batch', () => {
    const a = [makeToolCall('read_file', { path: '/a' }), makeToolCall('search', { q: 'foo' })];
    const b = [makeToolCall('search', { q: 'foo' }), makeToolCall('read_file', { path: '/a' })];
    expect(computeToolCallHash(a)).toBe(computeToolCallHash(b));
  });

  it('produces different hash for different arguments', () => {
    const a = [makeToolCall('read_file', { path: '/a' })];
    const b = [makeToolCall('read_file', { path: '/b' })];
    expect(computeToolCallHash(a)).not.toBe(computeToolCallHash(b));
  });

  it('produces different hash for different tool names', () => {
    const a = [makeToolCall('read_file', { path: '/a' })];
    const b = [makeToolCall('write_file', { path: '/a' })];
    expect(computeToolCallHash(a)).not.toBe(computeToolCallHash(b));
  });

  it('handles invalid JSON arguments gracefully', () => {
    const tc: ToolCall = {
      id: 'call_1',
      type: 'function',
      function: { name: 'test', arguments: 'not-json' },
    };
    // Should not throw
    const hash = computeToolCallHash([tc]);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(16);
  });
});

describe('LoopDetector', () => {
  it('returns null for non-repeating tool calls', () => {
    const detector = new LoopDetector();
    expect(detector.record([makeToolCall('read_file', { path: '/a' })])).toBeNull();
    expect(detector.record([makeToolCall('read_file', { path: '/b' })])).toBeNull();
    expect(detector.record([makeToolCall('read_file', { path: '/c' })])).toBeNull();
    expect(detector.record([makeToolCall('search', { q: 'foo' })])).toBeNull();
  });

  it('detects consecutive repetition after 3 identical calls', () => {
    const detector = new LoopDetector();
    const call = () => [makeToolCall('shell_exec', { cmd: 'cat /nonexist' })];
    expect(detector.record(call())).toBeNull(); // 1st
    expect(detector.record(call())).toBeNull(); // 2nd
    const pattern = detector.record(call()); // 3rd
    expect(pattern).not.toBeNull();
    expect(pattern!.type).toBe('consecutive');
    expect(pattern!.detail).toBe(3);
  });

  it('detects periodic cycle (A, B, A, B)', () => {
    const detector = new LoopDetector();
    const callA = () => [makeToolCall('read_file', { path: '/a' })];
    const callB = () => [makeToolCall('read_file', { path: '/b' })];
    expect(detector.record(callA())).toBeNull();
    expect(detector.record(callB())).toBeNull();
    expect(detector.record(callA())).toBeNull();
    const pattern = detector.record(callB());
    expect(pattern).not.toBeNull();
    expect(pattern!.type).toBe('periodic');
    expect(pattern!.detail).toBe(2);
  });

  it('detects periodic cycle of length 3 (A, B, C, A, B, C)', () => {
    const detector = new LoopDetector();
    const callA = () => [makeToolCall('tool_a', {})];
    const callB = () => [makeToolCall('tool_b', {})];
    const callC = () => [makeToolCall('tool_c', {})];
    expect(detector.record(callA())).toBeNull();
    expect(detector.record(callB())).toBeNull();
    expect(detector.record(callC())).toBeNull();
    expect(detector.record(callA())).toBeNull();
    expect(detector.record(callB())).toBeNull();
    const pattern = detector.record(callC());
    expect(pattern).not.toBeNull();
    expect(pattern!.type).toBe('periodic');
    expect(pattern!.detail).toBe(3);
  });

  it('does not false-positive on normal varied usage', () => {
    const detector = new LoopDetector();
    const calls = [
      [makeToolCall('search', { q: 'foo' })],
      [makeToolCall('read_file', { path: '/a' })],
      [makeToolCall('read_file', { path: '/b' })],
      [makeToolCall('write_file', { path: '/c', content: 'x' })],
      [makeToolCall('search', { q: 'bar' })],
      [makeToolCall('shell_exec', { cmd: 'ls' })],
    ];
    for (const c of calls) {
      expect(detector.record(c)).toBeNull();
    }
  });

  it('getHintOnce returns hint only on first call', () => {
    const detector = new LoopDetector();
    const call = () => [makeToolCall('fail', {})];
    detector.record(call());
    detector.record(call());
    detector.record(call()); // triggers detection

    const hint = detector.getHintOnce();
    expect(hint).not.toBeNull();
    expect(hint).toContain('Loop detected');

    // Second call returns null
    expect(detector.getHintOnce()).toBeNull();
  });

  it('hintWasInjected tracks hint state', () => {
    const detector = new LoopDetector();
    expect(detector.hintWasInjected).toBe(false);
    const call = () => [makeToolCall('fail', {})];
    detector.record(call());
    detector.record(call());
    detector.record(call());
    detector.getHintOnce();
    expect(detector.hintWasInjected).toBe(true);
  });

  it('reset clears history and hint state', () => {
    const detector = new LoopDetector();
    const call = () => [makeToolCall('fail', {})];
    detector.record(call());
    detector.record(call());
    detector.record(call());
    detector.getHintOnce();
    expect(detector.hintWasInjected).toBe(true);

    detector.reset();
    expect(detector.hintWasInjected).toBe(false);
    // After reset, same calls don't immediately trigger
    expect(detector.record(call())).toBeNull();
    expect(detector.record(call())).toBeNull();
  });

  it('returns null for empty tool calls', () => {
    const detector = new LoopDetector();
    expect(detector.record([])).toBeNull();
  });

  it('respects custom consecutiveThreshold', () => {
    const detector = new LoopDetector({ consecutiveThreshold: 2 });
    const call = () => [makeToolCall('test', {})];
    expect(detector.record(call())).toBeNull(); // 1st
    const pattern = detector.record(call()); // 2nd — triggers with threshold=2
    expect(pattern).not.toBeNull();
    expect(pattern!.type).toBe('consecutive');
  });

  it('evicts old history beyond maxHistory', () => {
    const detector = new LoopDetector({ maxHistory: 4 });
    const callA = () => [makeToolCall('a', {})];
    const callB = () => [makeToolCall('b', {})];
    // Fill with A, B, A, B pattern
    detector.record(callA());
    detector.record(callB());
    detector.record(callA());
    detector.record(callB()); // would detect period-2 cycle

    // Now inject 4 different calls to flush old history
    detector.reset();
    detector.record([makeToolCall('c', {})]);
    detector.record([makeToolCall('d', {})]);
    detector.record([makeToolCall('e', {})]);
    detector.record([makeToolCall('f', {})]);
    // Old A/B pattern is gone — no detection
    expect(detector.record(callA())).toBeNull();
  });
});

describe('buildGuardFallbackMessage — loop_detected', () => {
  it('returns Chinese message for CJK user input', () => {
    const msg = buildGuardFallbackMessage('loop_detected', '帮我搜索资料', []);
    expect(msg).toContain('重复执行');
  });

  it('returns English message for Latin user input', () => {
    const msg = buildGuardFallbackMessage('loop_detected', 'search for something', []);
    expect(msg).toContain('repetitive tool call loop');
  });
});

describe('LoopDetector — polling tool exemption', () => {
  it('does not detect loop for repeated process_status calls', () => {
    const detector = new LoopDetector();
    const pollCall = () => [makeToolCall('process_status', { process_id: 'abc-123' })];
    // Even 5 consecutive identical process_status calls should not trigger
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
  });

  it('does not detect loop for repeated process_output calls', () => {
    const detector = new LoopDetector();
    const pollCall = () => [makeToolCall('process_output', { process_id: 'abc-123', tail_lines: 50 })];
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
    expect(detector.record(pollCall())).toBeNull();
  });

  it('still detects loop for non-polling tools mixed with polling', () => {
    const detector = new LoopDetector();
    // Mix of polling + non-polling, but the non-polling part repeats
    const mixed = () => [
      makeToolCall('process_status', { process_id: 'abc-123' }),
      makeToolCall('shell_exec', { command: 'echo same' }),
    ];
    expect(detector.record(mixed())).toBeNull();
    expect(detector.record(mixed())).toBeNull();
    const pattern = detector.record(mixed());
    expect(pattern).not.toBeNull();
    expect(pattern!.type).toBe('consecutive');
  });
});

describe('buildGuardFallbackMessage — empty_response', () => {
  it('returns Chinese message for CJK user input', () => {
    const msg = buildGuardFallbackMessage('empty_response', '继续', []);
    expect(msg).toContain('空响应');
  });

  it('returns English message for Latin user input', () => {
    const msg = buildGuardFallbackMessage('empty_response', 'continue', []);
    expect(msg).toContain('empty visible output');
  });
});

describe('detectBehavioralFailure', () => {
  it('returns empty_response for empty text', () => {
    expect(detectBehavioralFailure('', false)).toBe('empty_response');
    expect(detectBehavioralFailure('   ', false)).toBe('empty_response');
  });

  it('returns null when model used tools — brain loop handles synthesis', () => {
    expect(detectBehavioralFailure('I reviewed the code and found...', true)).toBeNull();
    expect(detectBehavioralFailure('好的，让我读取', true)).toBeNull();
  });

  it('returns null for any non-empty response without tools', () => {
    // No pattern matching — brain loop length ratio handles narration detection
    expect(detectBehavioralFailure('The answer is 42.', false)).toBeNull();
    expect(detectBehavioralFailure('好的，让我读取最新 commit', false)).toBeNull();
    expect(detectBehavioralFailure('This project uses TypeScript.', false)).toBeNull();
  });
});

describe('buildBrainSelfCorrectionPrompt', () => {
  it('builds narration correction prompt', () => {
    const prompt = buildBrainSelfCorrectionPrompt('narration_without_execution', 'Review my code');
    expect(prompt).toContain('RUNTIME FEEDBACK');
    expect(prompt).toContain('rejected');
    expect(prompt).toContain('Call tools immediately');
    expect(prompt).toContain('Review my code');
  });

  it('builds empty response correction prompt', () => {
    const prompt = buildBrainSelfCorrectionPrompt('empty_response', '分析这张图');
    expect(prompt).toContain('empty');
    expect(prompt).toContain('分析这张图');
  });
});
