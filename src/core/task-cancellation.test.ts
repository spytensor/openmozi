import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const cancelMock = vi.fn();
  const getByIdMock = vi.fn();
  const logEventMock = vi.fn();
  return {
    cancelMock,
    getByIdMock,
    logEventMock,
  };
});

vi.mock('../store/task-dag.js', () => ({
  cancel: hoisted.cancelMock,
  getById: hoisted.getByIdMock,
}));

vi.mock('../store/events.js', () => ({
  log: hoisted.logEventMock,
}));

import {
  TaskCancelledError,
  registerRunningTask,
  registerTaskCancelHook,
  requestTaskCancellation,
  throwIfTaskCancelled,
  finishRunningTask,
  clearCancellationRequest,
  isTaskCancellationRequested,
  resetTaskCancellationRegistry,
} from './task-cancellation.js';

describe('core/task-cancellation', () => {
  beforeEach(() => {
    hoisted.cancelMock.mockReset();
    hoisted.getByIdMock.mockReset();
    hoisted.logEventMock.mockReset();
    hoisted.cancelMock.mockReturnValue(undefined);
    hoisted.getByIdMock.mockReturnValue({
      id: 't1',
      status: 'running',
    });
    resetTaskCancellationRegistry();
  });

  it('aborts active task signals when cancellation is requested', async () => {
    const signal = registerRunningTask({ taskId: 't1', tenantId: 'default' });
    expect(signal.aborted).toBe(false);

    const hook = vi.fn().mockResolvedValue(undefined);
    registerTaskCancelHook('t1', hook, 'default');

    const result = await requestTaskCancellation('t1', {
      tenantId: 'default',
      requestedBy: 'user-1',
      reason: 'test cancel',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('cancelled');
    expect(signal.aborted).toBe(true);
    expect(() => throwIfTaskCancelled(signal, 't1')).toThrow(TaskCancelledError);
    expect(hook).toHaveBeenCalledOnce();
  });

  it('records cancellation requests before task starts and aborts on register', async () => {
    const cancelResult = await requestTaskCancellation('t1', {
      tenantId: 'default',
      requestedBy: 'user-2',
      reason: 'cancel-before-run',
    });
    expect(cancelResult.ok).toBe(true);
    expect(isTaskCancellationRequested('t1', 'default')).toBe(true);

    const signal = registerRunningTask({ taskId: 't1', tenantId: 'default' });
    expect(signal.aborted).toBe(true);
    expect(() => throwIfTaskCancelled(signal, 't1')).toThrow('cancel-before-run');
  });

  it('returns not_found for unknown task IDs', async () => {
    hoisted.getByIdMock.mockReturnValue(null);

    const result = await requestTaskCancellation('missing-task', {
      tenantId: 'default',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('not_found');
    expect(hoisted.cancelMock).not.toHaveBeenCalled();
  });

  it('clears running and pending cancellation entries', async () => {
    registerRunningTask({ taskId: 't1', tenantId: 'default' });
    await requestTaskCancellation('t1', { tenantId: 'default' });
    expect(isTaskCancellationRequested('t1', 'default')).toBe(true);

    finishRunningTask('t1', 'default');
    clearCancellationRequest('t1', 'default');
    expect(isTaskCancellationRequested('t1', 'default')).toBe(false);
  });
});
