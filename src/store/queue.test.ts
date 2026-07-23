import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enqueue, dequeue, ack, fail } from './queue.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('store/queue', () => {
  it('enqueue returns an id', () => {
    const result = enqueue('test-ch', 'sender1', 'receiver1', { msg: 'hello' });
    expect(result.id).toBeGreaterThan(0);
  });

  it('dequeue returns the correct message', () => {
    enqueue('ch1', 'alice', 'bob', { text: 'hi bob' });
    const msg = dequeue('ch1', 'bob');
    expect(msg).not.toBeNull();
    expect(msg!.sender).toBe('alice');
    expect(msg!.receiver).toBe('bob');
    expect(msg!.payload).toEqual({ text: 'hi bob' });
  });

  it('dequeue respects priority ordering (lower number = higher priority)', () => {
    enqueue('prio-ch', 'a', 'b', { order: 'low' }, 5);
    enqueue('prio-ch', 'a', 'b', { order: 'high' }, 0);
    enqueue('prio-ch', 'a', 'b', { order: 'mid' }, 2);

    const first = dequeue('prio-ch', 'b');
    expect(first!.payload).toEqual({ order: 'high' });

    const second = dequeue('prio-ch', 'b');
    expect(second!.payload).toEqual({ order: 'mid' });

    const third = dequeue('prio-ch', 'b');
    expect(third!.payload).toEqual({ order: 'low' });
  });

  it('ack removes message from pending queue', () => {
    enqueue('ack-ch', 'x', 'y', { data: 1 });
    const msg = dequeue('ack-ch', 'y');
    expect(msg).not.toBeNull();
    ack(msg!.id);

    // Should not be dequeued again
    const again = dequeue('ack-ch', 'y');
    expect(again).toBeNull();
  });

  it('fail marks message as failed (not re-dequeueable)', () => {
    enqueue('fail-ch', 'x', 'y', { data: 2 });
    const msg = dequeue('fail-ch', 'y');
    expect(msg).not.toBeNull();
    fail(msg!.id);

    const again = dequeue('fail-ch', 'y');
    expect(again).toBeNull();
  });

  it('dequeue returns null for empty queue', () => {
    const msg = dequeue('empty-ch', 'nobody');
    expect(msg).toBeNull();
  });

  it('messages are scoped by channel and receiver', () => {
    enqueue('scope-ch', 'a', 'bob', { for: 'bob' });
    enqueue('scope-ch', 'a', 'alice', { for: 'alice' });

    const bobMsg = dequeue('scope-ch', 'bob');
    expect(bobMsg!.payload).toEqual({ for: 'bob' });

    const aliceMsg = dequeue('scope-ch', 'alice');
    expect(aliceMsg!.payload).toEqual({ for: 'alice' });
  });
});
