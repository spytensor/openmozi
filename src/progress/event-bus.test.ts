import { describe, it, expect, afterEach, vi } from 'vitest';
import { emit, on, removeAllListeners, type ProgressEvent } from './event-bus.js';

afterEach(() => {
  removeAllListeners();
});

describe('progress/event-bus', () => {
  it('emits events to subscribers', () => {
    const received: ProgressEvent[] = [];
    on((event) => received.push(event));

    emit({ type: 'tool_call', toolName: 'shell_exec' });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe('tool_call');
    expect(received[0].toolName).toBe('shell_exec');
  });

  it('adds timestamp automatically', () => {
    const received: ProgressEvent[] = [];
    on((event) => received.push(event));

    const before = Date.now();
    emit({ type: 'task_started', taskId: 't1' });
    const after = Date.now();

    expect(received[0].timestamp).toBeGreaterThanOrEqual(before);
    expect(received[0].timestamp).toBeLessThanOrEqual(after);
  });

  it('supports multiple subscribers', () => {
    const a: ProgressEvent[] = [];
    const b: ProgressEvent[] = [];
    on((event) => a.push(event));
    on((event) => b.push(event));

    emit({ type: 'dag_created', totalTasks: 3 });

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe stops delivery', () => {
    const received: ProgressEvent[] = [];
    const unsub = on((event) => received.push(event));

    emit({ type: 'tool_call', toolName: 'read_file' });
    expect(received).toHaveLength(1);

    unsub();
    emit({ type: 'tool_result', toolName: 'read_file' });
    expect(received).toHaveLength(1);
  });

  it('removeAllListeners clears all subscribers', () => {
    const received: ProgressEvent[] = [];
    on((event) => received.push(event));
    on((event) => received.push(event));

    removeAllListeners();

    emit({ type: 'task_completed', taskId: 't1' });
    expect(received).toHaveLength(0);
  });

  it('emits dag_created with totalTasks and completedTasks', () => {
    const received: ProgressEvent[] = [];
    on((event) => received.push(event));

    emit({ type: 'dag_created', totalTasks: 5, completedTasks: 0 });

    expect(received[0].totalTasks).toBe(5);
    expect(received[0].completedTasks).toBe(0);
  });

  it('emits task_failed with error', () => {
    const received: ProgressEvent[] = [];
    on((event) => received.push(event));

    emit({ type: 'task_failed', taskId: 't2', error: 'timeout' });

    expect(received[0].error).toBe('timeout');
    expect(received[0].taskId).toBe('t2');
  });

  it('emits tool_call and tool_result pairs', () => {
    const received: ProgressEvent[] = [];
    on((event) => received.push(event));

    emit({ type: 'tool_call', toolName: 'shell_exec' });
    emit({ type: 'tool_result', toolName: 'shell_exec', elapsed_ms: 150 });

    expect(received).toHaveLength(2);
    expect(received[0].type).toBe('tool_call');
    expect(received[1].type).toBe('tool_result');
    expect(received[1].elapsed_ms).toBe(150);
  });
});
