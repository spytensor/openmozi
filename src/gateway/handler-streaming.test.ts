import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { handleMessage, type ProgressCallback } from './handler.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { IncomingMessage } from '../channels/telegram.js';
import type { LLMClient, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from '../core/llm.js';
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

function makeMsg(text: string, chatId: string): IncomingMessage {
  return {
    channelType: 'telegram',
    chatId,
    userId: 'user_stream',
    username: 'streamtest',
    text,
    isCommand: false,
    timestamp: new Date(),
  };
}

function makeStreamingClient(chunks: string[]): LLMClient {
  const fullText = chunks.join('');
  return {
    provider: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: fullText,
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse),
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      let accumulated = '';
      for (const chunk of chunks) {
        accumulated += chunk;
        yield { type: 'text', text: chunk };
      }
      yield {
        type: 'done',
        response: {
          content: accumulated,
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'mock-model',
          stop_reason: 'end',
        },
      };
    },
  };
}

describe('gateway/handler streaming', () => {
  it('calls onStreamEnd with full text when streaming completes', async () => {
    const client = makeStreamingClient(['Complete response']);
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onStreamChunk: vi.fn(),
      onStreamEnd: vi.fn(),
    };

    await handleMessage(makeMsg('test', 'stream_end_test'), 'sys', client, progress);

    expect(progress.onStreamEnd).toHaveBeenCalledWith('Complete response');
  });

  it('works without streaming callbacks (backward compatible)', async () => {
    const client = makeStreamingClient(['fallback']);
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      // No onStreamChunk or onStreamEnd
    };

    const result = await handleMessage(makeMsg('test', 'no_stream_test'), 'sys', client, progress);
    // Should use non-streaming path
    expect(result).toBeTruthy();
  });

  it('strips partial legacy TOOL_CALL protocol text when stream is cut mid-block', async () => {
    const client = makeStreamingClient([
      '准备执行。\n',
      '[TOOL_CALL] {tool => "web_search", args => { --query "openclaw real world" }}',
    ]);
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onStreamChunk: vi.fn(),
      onStreamEnd: vi.fn(),
    };

    const result = await handleMessage(makeMsg('继续', 'stream_partial_tool_call_leak_test'), 'sys', client, progress);
    expect(result).toContain('准备执行。');
    expect(result).not.toContain('TOOL_CALL');
    expect(result).not.toContain('web_search');
  });

});
