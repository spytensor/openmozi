import { describe, it, expect } from 'vitest';
import { createWsResponse, type WsOutgoingMessage } from './websocket.js';

describe('channels/websocket streaming message types', () => {
  it('supports stream_start message type', () => {
    const msg: WsOutgoingMessage = {
      type: 'stream_start',
      requestId: 'req-123',
    };
    expect(msg.type).toBe('stream_start');
    expect(msg.requestId).toBe('req-123');
  });

  it('supports stream_chunk message type', () => {
    const msg: WsOutgoingMessage = {
      type: 'stream_chunk',
      requestId: 'req-123',
      content: 'Hello world',
    };
    expect(msg.type).toBe('stream_chunk');
    expect(msg.content).toBe('Hello world');
  });

  it('supports stream_end message type', () => {
    const msg: WsOutgoingMessage = {
      type: 'stream_end',
      requestId: 'req-123',
      content: 'Full response text',
    };
    expect(msg.type).toBe('stream_end');
    expect(msg.content).toBe('Full response text');
  });

  it('supports message type with role', () => {
    const msg: WsOutgoingMessage = {
      type: 'message',
      role: 'assistant',
      content: 'Hello!',
    };
    expect(msg.type).toBe('message');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello!');
  });

  it('supports error type with message field', () => {
    const msg: WsOutgoingMessage = {
      type: 'error',
      message: 'Something went wrong',
    };
    expect(msg.type).toBe('error');
    expect(msg.message).toBe('Something went wrong');
  });

  it('supports tool_event execution message type', () => {
    const msg: WsOutgoingMessage = {
      type: 'tool_event',
      phase: 'start',
      tool: 'web_search',
      callId: 'call_123',
      status: 'running',
      timestamp: Date.now(),
    };
    expect(msg.type).toBe('tool_event');
    expect(msg.phase).toBe('start');
    expect(msg.tool).toBe('web_search');
    expect(msg.status).toBe('running');
  });

  it('createWsResponse still works for legacy callers', () => {
    const json = createWsResponse('message', 'test');
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('message');
    expect(parsed.text).toBe('test');
  });
});
