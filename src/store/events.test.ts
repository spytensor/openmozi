import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { log, query, queryByEventType } from './events.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('store/events', () => {
  it('log returns an id', () => {
    const result = log('task_created', 'task', 'task_001', { title: 'Test' });
    expect(result.id).toBeGreaterThan(0);
  });

  it('query returns events by entity', () => {
    log('started', 'agent', 'agent_01', { status: 'running' });
    log('completed', 'agent', 'agent_01', { status: 'done' });

    const events = query('agent', 'agent_01');
    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe('started');
    expect(events[1].event_type).toBe('completed');
    expect(events[0].payload).toEqual({ status: 'running' });
  });

  it('query returns empty array for unknown entity', () => {
    const events = query('task', 'nonexistent_999');
    expect(events).toEqual([]);
  });

  it('events have correct structure', () => {
    log('test_event', 'session', 'sess_01', { key: 'value' });
    const events = query('session', 'sess_01');
    expect(events).toHaveLength(1);

    const event = events[0];
    expect(event).toHaveProperty('id');
    expect(event).toHaveProperty('event_type', 'test_event');
    expect(event).toHaveProperty('entity_type', 'session');
    expect(event).toHaveProperty('entity_id', 'sess_01');
    expect(event).toHaveProperty('payload');
    expect(event).toHaveProperty('created_at');
  });

  it('events are scoped by tenant_id', () => {
    log('ev1', 'task', 't1', { a: 1 }, 'tenant_A');
    log('ev2', 'task', 't1', { b: 2 }, 'tenant_B');

    const eventsA = query('task', 't1', 'tenant_A');
    expect(eventsA).toHaveLength(1);
    expect(eventsA[0].payload).toEqual({ a: 1 });

    const eventsB = query('task', 't1', 'tenant_B');
    expect(eventsB).toHaveLength(1);
    expect(eventsB[0].payload).toEqual({ b: 2 });
  });

  it('queryByEventType returns most recent events with tenant scope and limit', () => {
    log('agent_loop_decision', 'agent_loop', 'loop-1', { cycle: 1 }, 'tenant_A');
    log('agent_loop_decision', 'agent_loop', 'loop-2', { cycle: 2 }, 'tenant_A');
    log('agent_loop_decision', 'agent_loop', 'loop-3', { cycle: 3 }, 'tenant_B');

    const eventsA = queryByEventType('agent_loop_decision', 'tenant_A', 10);
    expect(eventsA).toHaveLength(2);
    expect(eventsA[0].entity_id).toBe('loop-2');
    expect(eventsA[1].entity_id).toBe('loop-1');

    const limited = queryByEventType('agent_loop_decision', 'tenant_A', 1);
    expect(limited).toHaveLength(1);
    expect((limited[0].payload as { cycle: number }).cycle).toBe(2);

    const eventsB = queryByEventType('agent_loop_decision', 'tenant_B', 10);
    expect(eventsB).toHaveLength(1);
    expect((eventsB[0].payload as { cycle: number }).cycle).toBe(3);
  });
});
