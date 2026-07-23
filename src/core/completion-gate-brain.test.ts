import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatResponse, LLMClient } from './llm.js';
import type { ToolResult } from '../tools/types.js';

const hoisted = vi.hoisted(() => ({ testsFail: false }));

vi.mock('../tools/executor.js', () => ({
  extractToolIntent: () => undefined,
  extractToolSkillName: () => undefined,
  executeToolCalls: vi.fn(async (calls: Array<{ id: string; function: { name: string; arguments: string } }>) => (
    calls.map((call): ToolResult => {
      const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
      const failed = call.function.name === 'run_tests' && hoisted.testsFail;
      return {
        tool_call_id: call.id,
        tool_name: call.function.name,
        content: failed ? '2 tests failed' : `${call.function.name} ok`,
        is_error: failed,
        file_path: typeof args.path === 'string' ? args.path : undefined,
      };
    })
  )),
}));

import { brainExecute, type BrainExecutionOptions } from './brain-engine.js';

function toolResponse(id: string, name: string, args: Record<string, unknown>): ChatResponse {
  return {
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    usage: { input_tokens: 5, output_tokens: 2 },
    model: 'scripted-gate',
    stop_reason: 'tool-calls',
  };
}

function textResponse(content: string): ChatResponse {
  return {
    content,
    usage: { input_tokens: 5, output_tokens: 2 },
    model: 'scripted-gate',
    stop_reason: 'end_turn',
  };
}

function scriptedClient(responses: ChatResponse[]): LLMClient {
  let index = 0;
  return {
    provider: 'scripted-gate',
    chat: vi.fn(async () => responses[Math.min(index++, responses.length - 1)]),
    chatStream: vi.fn(),
  } as unknown as LLMClient;
}

function options(client: LLMClient): BrainExecutionOptions {
  return {
    client,
    tenantId: 'gate-tenant',
    contextMessages: [
      { role: 'system', content: 'Test runtime.' },
      { role: 'user', content: 'Modify the requested file.' },
    ],
    maxTokens: 1000,
    temperature: 0,
    toolContext: {
      chatId: 'gate-chat',
      tenantId: 'gate-tenant',
      agentId: 'gate-agent',
      permissionLevel: 'L3_FULL_ACCESS',
    },
    progress: { onToolStart: vi.fn(), onToolEnd: vi.fn(), onProcessingStart: vi.fn() },
    chatId: 'gate-chat',
    turnId: 'gate-turn',
    taskId: 'gate-task',
    maxIterations: 10,
    llmCallTimeoutMs: 0,
    maxLoopElapsedMs: 0,
    repeatedBatchThreshold: 3,
    maxFailedToolBatches: 3,
    selfHealRetries: 0,
    selfHealBackoffMs: 0,
  };
}

describe('brain completion gate integration', () => {
  beforeEach(() => { hoisted.testsFail = false; });

  it('rejects a premature code completion and accepts it after diff and tests', async () => {
    const client = scriptedClient([
      toolResponse('write', 'write_file', { path: 'src/fix.ts', content: 'export {}' }),
      textResponse('Done without verification.'),
      {
        ...textResponse(''),
        tool_calls: [
          { id: 'diff', type: 'function', function: { name: 'git_diff', arguments: '{}' } },
          { id: 'tests', type: 'function', function: { name: 'run_tests', arguments: '{}' } },
        ],
        stop_reason: 'tool-calls',
      },
      textResponse('Verified and complete.'),
    ]);

    const result = await brainExecute(options(client));

    expect(result.responseText).toBe('Verified and complete.');
    expect(result.completionGateDecision.status).toBe('passed');
    const verifierCallMessages = vi.mocked(client.chat).mock.calls[2][0] as ChatMessage[];
    expect(verifierCallMessages.some(message => String(message.content).includes('RUNTIME VERIFIER'))).toBe(true);
  });

  it('cannot hide failed tests behind repeated completion text', async () => {
    hoisted.testsFail = true;
    const client = scriptedClient([
      toolResponse('write', 'write_file', { path: 'src/fix.ts', content: 'broken' }),
      {
        ...textResponse(''),
        tool_calls: [
          { id: 'diff', type: 'function', function: { name: 'git_diff', arguments: '{}' } },
          { id: 'tests', type: 'function', function: { name: 'run_tests', arguments: '{}' } },
        ],
        stop_reason: 'tool-calls',
      },
      textResponse('Everything passed.'),
      textResponse('Everything passed.'),
      textResponse('Everything passed.'),
    ]);

    const result = await brainExecute(options(client));

    expect(result.completionGateBlocked).toBe(true);
    expect(result.completionGateDecision.status).toBe('failed');
    expect(result.responseText).not.toContain('Everything passed');
    expect(result.responseText).toContain('2 tests failed');
  });

  it('accepts non-code changes only after readback', async () => {
    const client = scriptedClient([
      toolResponse('write', 'write_file', { path: 'docs/report.md', content: '# Report' }),
      textResponse('Report complete.'),
      toolResponse('read', 'read_file', { path: 'docs/report.md' }),
      textResponse('Report verified.'),
    ]);

    const result = await brainExecute(options(client));
    expect(result.responseText).toBe('Report verified.');
    expect(result.completionGateDecision.status).toBe('passed');
  });

  it('leaves non-mutating chat unchanged', async () => {
    const client = scriptedClient([textResponse('Direct answer.')]);
    const result = await brainExecute(options(client));
    expect(result.responseText).toBe('Direct answer.');
    expect(result.completionGateDecision.status).toBe('not_required');
    expect(client.chat).toHaveBeenCalledOnce();
  });

  it('does not stream an unverified completion claim to the user', async () => {
    const responses = [
      toolResponse('write', 'write_file', { path: 'docs/report.md', content: '# Report' }),
      textResponse('Unverified completion claim.'),
      textResponse('Unverified completion claim.'),
      textResponse('Unverified completion claim.'),
    ];
    let index = 0;
    const client: LLMClient = {
      provider: 'scripted-gate',
      chat: vi.fn(),
      chatStream: vi.fn(async function* () {
        const response = responses[Math.min(index++, responses.length - 1)];
        if (response.content) yield { type: 'text' as const, text: response.content };
        yield { type: 'done' as const, response };
      }),
    };
    const onStreamChunk = vi.fn();
    const gateOptions = options(client);
    gateOptions.progress = {
      ...gateOptions.progress,
      onStreamChunk,
      onStreamEnd: vi.fn(),
    };

    const result = await brainExecute(gateOptions);
    expect(result.completionGateBlocked).toBe(true);
    expect(onStreamChunk).not.toHaveBeenCalled();
  });
});
