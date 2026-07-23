import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { handleMessage, type ProgressCallback } from './handler.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { IncomingMessage } from '../channels/telegram.js';
import type { LLMClient, ChatMessage, ChatOptions, ChatResponse, StreamChunk, ToolCall } from '../core/llm.js';
import { removeAllListeners } from '../progress/event-bus.js';

// Mock model-router so handleMessage always uses our fallback client
vi.mock('../core/model-router.js', () => ({
  getBrainClient: () => { throw new Error('No brain client in test'); },
  getClientForTask: () => { throw new Error('No lightweight client in test'); },
  selectModel: () => ({ model: 'mock', provider: 'mock', role: 'general' }),
  getClient: () => { throw new Error('No client'); },
}));

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
  removeAllListeners();
});

function makeMsg(text: string, chatId = 'progress_test'): IncomingMessage {
  return {
    channelType: 'telegram',
    chatId,
    userId: 'user_1',
    username: 'testuser',
    text,
    isCommand: false,
    timestamp: new Date(),
  };
}

function makeMockClient(reply = 'Mock reply'): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: reply,
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse),
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: reply };
      yield { type: 'done', response: { content: reply, usage: { input_tokens: 10, output_tokens: 20 }, model: 'mock-model', stop_reason: 'end' } };
    },
  };
}

function makeToolClient(): LLMClient {
  let callCount = 0;
  return {
    provider: 'mock',
    chat: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First call returns tool calls
        return {
          content: '',
          tool_calls: [
            {
              id: 'tc_1',
              type: 'function' as const,
              function: { name: 'shell_exec', arguments: '{"command":"echo hi"}' },
            },
          ],
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'mock-model',
          stop_reason: 'tool_calls',
        };
      }
      // Second call returns final response
      return {
        content: 'Done',
        usage: { input_tokens: 10, output_tokens: 20 },
        model: 'mock-model',
        stop_reason: 'end',
      };
    }),
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'Done' };
      yield { type: 'done', response: { content: 'Done', usage: { input_tokens: 10, output_tokens: 20 }, model: 'mock-model', stop_reason: 'end' } };
    },
  };
}

describe('gateway/handler progress callbacks', () => {
  it('calls onProcessingStart when message processing begins', async () => {
    const client = makeMockClient();
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };

    await handleMessage(makeMsg('hi', 'progress_start_test'), 'sys', client, progress);

    expect(progress.onProcessingStart).toHaveBeenCalledTimes(1);
  });

  it('does not call onToolStart for simple responses without tools', async () => {
    const client = makeMockClient();
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };

    await handleMessage(makeMsg('hello', 'no_tool_test'), 'sys', client, progress);

    expect(progress.onToolStart).not.toHaveBeenCalled();
    expect(progress.onToolEnd).not.toHaveBeenCalled();
  });

  it('calls onToolStart and onToolEnd for tool-calling responses', async () => {
    const client = makeToolClient();
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
    };

    await handleMessage(makeMsg('run a command', 'tool_progress_test'), 'sys', client, progress);

    expect(progress.onToolStart).toHaveBeenCalledWith('shell_exec');
    expect(progress.onToolEnd).toHaveBeenCalledWith('shell_exec');
  });

  it('works without progress callback (default no-op)', async () => {
    const client = makeMockClient();

    // Should not throw when no progress callback is provided
    const result = await handleMessage(makeMsg('hi', 'noop_test'), 'sys', client);
    expect(result).toBe('Mock reply');
  });
});
