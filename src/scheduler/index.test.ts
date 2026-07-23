import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { schedule, cancel, list, start, stop, reset } from './index.js';

describe('scheduler/index', () => {
  beforeEach(() => {
    reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(async () => {
    stop();
    reset();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('registers tasks and lists them', () => {
    const taskId = schedule({
      name: 'task-a',
      interval_minutes: 5,
      run: () => {},
    });

    const tasks = list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(taskId);
    expect(tasks[0].name).toBe('task-a');
    expect(tasks[0].interval_minutes).toBe(5);
    expect(tasks[0].last_run_at).toBeNull();
  });

  it('cancels tasks by task ID', () => {
    const taskId = schedule({
      interval_minutes: 2,
      run: () => {},
    });

    expect(cancel(taskId)).toBe(true);
    expect(cancel(taskId)).toBe(false);
    expect(list()).toEqual([]);
  });

  it('runs due tasks every 60 seconds after start', async () => {
    const run = vi.fn();
    schedule({
      id: 'every-minute',
      interval_minutes: 1,
      run,
    });

    start();
    expect(run).toHaveBeenCalledTimes(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stop clears scheduler intervals', async () => {
    const run = vi.fn();
    schedule({
      interval_minutes: 1,
      run,
    });

    start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);

    stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent', async () => {
    const run = vi.fn();
    schedule({
      interval_minutes: 1,
      run,
    });

    start();
    start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
