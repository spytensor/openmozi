import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createMessage, send, receive, broadcast, AgentMessageSchema } from './messaging.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('agents/messaging', () => {
  describe('createMessage', () => {
    it('creates a well-formed AgentMessage', () => {
      const msg = createMessage('agent-a', 'agent-b', 'task_delegate', { task: 'do stuff' });
      expect(msg.id).toMatch(/^msg_/);
      expect(msg.from).toBe('agent-a');
      expect(msg.to).toBe('agent-b');
      expect(msg.type).toBe('task_delegate');
      expect(msg.payload).toEqual({ task: 'do stuff' });
      expect(msg.timestamp).toBeGreaterThan(0);
      expect(msg.reply_to).toBeUndefined();
    });

    it('includes reply_to when provided', () => {
      const msg = createMessage('a', 'b', 'result_share', null, 'msg_original');
      expect(msg.reply_to).toBe('msg_original');
    });
  });

  describe('send + receive round trip', () => {
    it('sends and receives a message', () => {
      const msg = createMessage('brain', 'worker-1', 'task_delegate', { objective: 'search' });
      send(msg);

      const received = receive('worker-1');
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(msg.id);
      expect(received[0].from).toBe('brain');
      expect(received[0].to).toBe('worker-1');
      expect(received[0].payload).toEqual({ objective: 'search' });
    });

    it('does not return already-received messages', () => {
      const msg = createMessage('brain', 'worker-2', 'status_update', { status: 'ok' });
      send(msg);

      const first = receive('worker-2');
      expect(first).toHaveLength(1);

      const second = receive('worker-2');
      expect(second).toHaveLength(0);
    });

    it('receives all pending messages for the agent', () => {
      const msg1 = createMessage('a', 'worker-3', 'help_request', { order: 1 });
      const msg2 = createMessage('b', 'worker-3', 'result_share', { order: 2 });
      send(msg1);
      send(msg2);

      const received = receive('worker-3');
      expect(received).toHaveLength(2);
      const ids = received.map((m) => m.id);
      expect(ids).toContain(msg1.id);
      expect(ids).toContain(msg2.id);
    });
  });

  describe('receive returns empty when no messages', () => {
    it('returns empty array for unknown agent', () => {
      const received = receive('nonexistent-agent');
      expect(received).toEqual([]);
    });
  });

  describe('Zod validation', () => {
    it('rejects invalid message type', () => {
      expect(() =>
        AgentMessageSchema.parse({
          id: 'msg_1',
          from: 'a',
          to: 'b',
          type: 'invalid_type',
          payload: {},
          timestamp: Date.now(),
        }),
      ).toThrow();
    });

    it('rejects message missing required fields', () => {
      expect(() =>
        AgentMessageSchema.parse({
          id: 'msg_1',
          from: 'a',
          // missing to, type, payload, timestamp
        }),
      ).toThrow();
    });

    it('send rejects invalid message', () => {
      expect(() =>
        send({ id: 'x', from: 'a', to: 'b', type: 'bad' as 'task_delegate', payload: null, timestamp: 0 }),
      ).toThrow();
    });
  });

  describe('broadcast', () => {
    it('sends no messages when no active agents', () => {
      // listActive() returns [] since we have no spawned processes in test
      // This should not throw
      broadcast('brain', 'status_update', { info: 'all good' });

      // Nothing to receive since no agents were active
      const received = receive('broadcast');
      expect(received).toEqual([]);
    });
  });
});
