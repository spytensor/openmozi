import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const timeoutHoisted = vi.hoisted(() => ({
  report: vi.fn(() => ({
    applied: true,
    reason: 'timeout_budget_increased',
    previousCallTimeoutMs: 10_000,
    previousLoopTimeoutMs: 40_000,
    previousInteractiveTurnTimeoutMs: 40_000,
    nextCallTimeoutMs: 15_000,
    nextLoopTimeoutMs: 50_000,
    nextInteractiveTurnTimeoutMs: 50_000,
  })),
}));

vi.mock('./autonomous-timeout.js', () => ({
  reportTimeoutAndMaybeTune: timeoutHoisted.report,
}));

import { brainExecute, type BrainExecutionOptions } from './brain-engine.js';
import type { ChatMessage, ChatResponse, LLMClient } from './llm.js';
import { loadConfig } from '../config/index.js';
import { getConfigPath } from '../paths.js';
import { getOutputDir } from '../tools/workspace-policy.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

function response(content: string, toolCalls?: ChatResponse['tool_calls']): ChatResponse {
  return {
    content,
    tool_calls: toolCalls,
    usage: { input_tokens: 5, output_tokens: 2 },
    model: 'kernel-test',
    stop_reason: toolCalls ? 'tool-calls' : 'end_turn',
  };
}

function options(
  client: LLMClient,
  progressOverrides: Partial<BrainExecutionOptions['progress']> = {},
): BrainExecutionOptions {
  return {
    client,
    tenantId: 'tenant-gateway-kernel',
    contextMessages: [
      { role: 'system', content: 'You are MOZI.' },
      { role: 'user', content: 'Complete the task.' },
    ],
    maxTokens: 1024,
    temperature: 0,
    toolContext: {
      tenantId: 'tenant-gateway-kernel',
      chatId: 'chat-gateway-kernel',
      agentId: 'session:gateway-kernel',
      permissionLevel: 'L3_FULL_ACCESS',
    },
    progress: {
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onProcessingStart: vi.fn(),
      ...progressOverrides,
    },
    chatId: 'chat-gateway-kernel',
    turnId: 'turn-gateway-kernel',
    taskId: 'task-gateway-kernel',
    maxIterations: 10,
    llmCallTimeoutMs: 10_000,
    maxLoopElapsedMs: 60_000,
    repeatedBatchThreshold: 2,
    maxFailedToolBatches: 2,
    selfHealRetries: 1,
    selfHealBackoffMs: 0,
  };
}

function systemText(messages: ChatMessage[]): string {
  return messages
    .filter(message => message.role === 'system')
    .map(message => String(message.content))
    .join('\n');
}

beforeEach(() => {
  timeoutHoisted.report.mockReset();
  timeoutHoisted.report.mockReturnValue({
    applied: true,
    reason: 'timeout_budget_increased',
    previousCallTimeoutMs: 10_000,
    previousLoopTimeoutMs: 40_000,
    previousInteractiveTurnTimeoutMs: 40_000,
    nextCallTimeoutMs: 15_000,
    nextLoopTimeoutMs: 50_000,
    nextInteractiveTurnTimeoutMs: 50_000,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('interactive Brain UnifiedExecutionKernel wiring', () => {
  it('feeds runtime truth and fixed constraint recovery into the next real Brain model call', async () => {
    const missingPath = 'definitely-missing-mozi-kernel-test.txt';
    const client = {
      chat: vi.fn()
        .mockResolvedValueOnce(response('', [{
          id: 'read-missing',
          type: 'function',
          function: { name: 'read_file', arguments: JSON.stringify({ path: missingPath }) },
        }]))
        .mockResolvedValueOnce(response('Recovered with the correct path.')),
      chatStream: vi.fn(),
    } as unknown as LLMClient;

    const result = await brainExecute(options(client));
    const secondCallMessages = vi.mocked(client.chat).mock.calls[1][0];
    const directives = systemText(secondCallMessages);

    expect(result.responseText).toBe('Recovered with the correct path.');
    expect(directives).toContain('Runtime tool outcomes (ground truth)');
    expect(directives).toContain('"tool":"read_file"');
    expect(directives).toContain('"status":"error"');
    expect(directives).toContain('requested path does not exist');
    expect(directives).not.toContain(missingPath);
  });

  it('blocks repeated side effects before a second execution, then stops boundedly', async () => {
    const savedMoziHome = process.env.MOZI_HOME;
    const moziHome = mkdtempSync(join(tmpdir(), 'mozi-gateway-kernel-'));
    const { tmpDir: dbTmpDir } = setupTestDb();
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());
    try {
      const target = join(getOutputDir(), 'repeat-guard.txt');
      const repeatedCall = (id: string) => ({
        id,
        type: 'function' as const,
        function: {
          name: 'write_file',
          arguments: JSON.stringify({ path: target, content: 'written once' }),
        },
      });
      const client = {
        chat: vi.fn()
          .mockResolvedValueOnce(response('', [repeatedCall('write-1')]))
          .mockResolvedValueOnce(response('', [repeatedCall('write-2')]))
          .mockResolvedValueOnce(response('', [repeatedCall('write-3')])),
        chatStream: vi.fn(),
      } as unknown as LLMClient;
      const onToolStart = vi.fn();

      const result = await brainExecute(options(client, { onToolStart }));
      const secondCallDirectives = systemText(vi.mocked(client.chat).mock.calls[1][0]);
      const thirdCallDirectives = systemText(vi.mocked(client.chat).mock.calls[2][0]);

      expect(result.recovered).toBe(true);
      expect(result.completionGateBlocked).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('written once');
      expect(onToolStart).toHaveBeenCalledTimes(1);
      expect(secondCallDirectives).toContain('Runtime tool outcomes (ground truth)');
      expect(thirdCallDirectives).toContain('Loop detected');
    } finally {
      teardownTestDb(dbTmpDir);
      rmSync(moziHome, { recursive: true, force: true });
      if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
      else process.env.MOZI_HOME = savedMoziHome;
      loadConfig('/nonexistent/mozi.json');
    }
  });

  it('clears partial streaming output and sends the autotune directive on retry', async () => {
    let streamCalls = 0;
    let retryMessages: ChatMessage[] = [];
    const client = {
      chat: vi.fn(() => new Promise<ChatResponse>(() => undefined)),
      chatStream: vi.fn(async function* (messages: ChatMessage[]) {
        streamCalls += 1;
        if (streamCalls === 1) {
          yield { type: 'text' as const, text: 'partial output that must be cleared' };
          throw new Error('provider stream timeout');
        }
        retryMessages = messages.map(message => ({ ...message }));
        yield { type: 'text' as const, text: 'Recovered stream.' };
        yield { type: 'done' as const, response: response('Recovered stream.') };
      }),
    } as unknown as LLMClient;
    const onStreamChunk = vi.fn();
    const onStreamEnd = vi.fn();
    const onStreamReset = vi.fn();

    const result = await brainExecute(options(client, { onStreamChunk, onStreamEnd, onStreamReset }));

    expect(result.responseText).toBe('Recovered stream.');
    expect(streamCalls).toBe(2);
    expect(systemText(retryMessages)).toContain('Runtime timeout budgets were auto-tuned');
    expect(onStreamChunk).toHaveBeenCalledWith('partial output that must be cleared');
    expect(onStreamReset).toHaveBeenCalledTimes(1);
    expect(onStreamEnd).not.toHaveBeenCalledWith('');
    expect(timeoutHoisted.report).toHaveBeenCalledWith(expect.objectContaining({ scope: 'gateway' }));
  });

  it('allows a non-streaming provider timeout to complete failover within the gateway budget', async () => {
    const attempts: string[] = [];
    const client = {
      chat: vi.fn(async (_messages: ChatMessage[], callOptions?: { timeout_ms?: number }) => {
        attempts.push('primary');
        await new Promise(resolve => setTimeout(resolve, (callOptions?.timeout_ms ?? 0) + 10));
        attempts.push('fallback');
        return response('Fallback completed the turn.');
      }),
      chatStream: vi.fn(),
    } as unknown as LLMClient;

    const result = await brainExecute({
      ...options(client),
      llmCallTimeoutMs: 20,
      maxLoopElapsedMs: 100,
      selfHealRetries: 0,
    });

    expect(result.responseText).toBe('Fallback completed the turn.');
    expect(attempts).toEqual(['primary', 'fallback']);
    expect(client.chat).toHaveBeenCalledTimes(1);
    expect(timeoutHoisted.report).not.toHaveBeenCalled();
  });

  it('allows a streaming provider timeout to complete failover without a late stream', async () => {
    const attempts: string[] = [];
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* (_messages: ChatMessage[], callOptions?: { timeout_ms?: number }) {
        attempts.push('primary');
        await new Promise(resolve => setTimeout(resolve, (callOptions?.timeout_ms ?? 0) + 10));
        attempts.push('fallback');
        yield { type: 'text' as const, text: 'Fallback stream completed.' };
        yield { type: 'done' as const, response: response('Fallback stream completed.') };
      }),
    } as unknown as LLMClient;

    const result = await brainExecute({
      ...options(client, { onStreamChunk: vi.fn(), onStreamEnd: vi.fn(), onStreamReset: vi.fn() }),
      llmCallTimeoutMs: 20,
      maxLoopElapsedMs: 100,
      selfHealRetries: 0,
    });

    expect(result.responseText).toBe('Fallback stream completed.');
    expect(attempts).toEqual(['primary', 'fallback']);
    expect(client.chatStream).toHaveBeenCalledTimes(1);
    expect(timeoutHoisted.report).not.toHaveBeenCalled();
  });

  it('does not classify an explicit user abort as a timeout or autotune it', async () => {
    const controller = new AbortController();
    const client = {
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        yield { type: 'text' as const, text: 'partial' };
        controller.abort(new Error('User cancelled this turn'));
        yield { type: 'text' as const, text: 'unreachable' };
      }),
    } as unknown as LLMClient;

    await expect(brainExecute({
      ...options(client, { onStreamChunk: vi.fn(), onStreamEnd: vi.fn() }),
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'User cancelled this turn' });

    expect(timeoutHoisted.report).not.toHaveBeenCalled();
  });

  it('bounds a stream whose iterator never resolves with a gateway-owned deadline', async () => {
    timeoutHoisted.report.mockReturnValue({
      applied: false,
      reason: 'at_limit',
      previousCallTimeoutMs: 20,
      previousLoopTimeoutMs: 45,
      previousInteractiveTurnTimeoutMs: 45,
      nextCallTimeoutMs: 20,
      nextLoopTimeoutMs: 45,
      nextInteractiveTurnTimeoutMs: 45,
    });
    const client = {
      chat: vi.fn(() => new Promise<ChatResponse>(() => undefined)),
      chatStream: vi.fn(async function* () {
        await new Promise<never>(() => undefined);
      }),
    } as unknown as LLMClient;
    const onStreamReset = vi.fn();
    const startedAt = Date.now();

    const result = await brainExecute({
      ...options(client, { onStreamChunk: vi.fn(), onStreamEnd: vi.fn(), onStreamReset }),
      llmCallTimeoutMs: 20,
      maxLoopElapsedMs: 45,
      selfHealRetries: 0,
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result.recovered).toBe(true);
    expect(result.recoveryMode).toBe('fallback');
    expect(onStreamReset).toHaveBeenCalled();
  });

  it('propagates user cancellation after recovery has started', async () => {
    timeoutHoisted.report.mockReturnValue({
      applied: false,
      reason: 'at_limit',
      previousCallTimeoutMs: 10_000,
      previousLoopTimeoutMs: 1_000,
      previousInteractiveTurnTimeoutMs: 1_000,
      nextCallTimeoutMs: 10_000,
      nextLoopTimeoutMs: 1_000,
      nextInteractiveTurnTimeoutMs: 1_000,
    });
    const controller = new AbortController();
    const client = {
      chat: vi.fn()
        .mockRejectedValueOnce(new Error('provider timeout'))
        .mockImplementationOnce(() => new Promise<ChatResponse>(() => {
          queueMicrotask(() => controller.abort(new Error('User cancelled during recovery')));
        })),
      chatStream: vi.fn(),
    } as unknown as LLMClient;

    await expect(brainExecute({
      ...options(client),
      abortSignal: controller.signal,
      maxIterations: 1,
      maxLoopElapsedMs: 1_000,
    })).rejects.toMatchObject({ name: 'AbortError', message: 'User cancelled during recovery' });

    expect(vi.mocked(client.chat)).toHaveBeenCalledTimes(2);
    expect(timeoutHoisted.report).toHaveBeenCalledTimes(1);
  });
});
