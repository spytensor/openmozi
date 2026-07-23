import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  diagnoseManagedTaskRepairMock: vi.fn(),
  repairManagedTaskMock: vi.fn(),
}));

vi.mock('../core/task-repair.js', () => ({
  diagnoseManagedTaskRepair: hoisted.diagnoseManagedTaskRepairMock,
  repairManagedTask: hoisted.repairManagedTaskMock,
}));

import { executeSystemTool } from './system-tools.js';

describe('tools/system-tools repair_task', () => {
  it('uses diagnose mode by default', async () => {
    hoisted.diagnoseManagedTaskRepairMock.mockReturnValueOnce({
      task: { id: 'task-1', status: 'failed' },
      category: 'timed_out',
      repairable: true,
    });

    const result = await executeSystemTool(
      'repair_task',
      { task_id: 'task-1' },
      'call-repair-diagnose',
      { tenantId: 'tenant-repair' },
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.diagnoseManagedTaskRepairMock).toHaveBeenCalledWith('task-1', 'tenant-repair');
    expect(hoisted.repairManagedTaskMock).not.toHaveBeenCalled();
  });

  it('forwards runtime context in repair_and_run mode', async () => {
    hoisted.repairManagedTaskMock.mockResolvedValueOnce({
      diagnosis: { task: { id: 'task-2' }, category: 'runtime_error' },
      reset_task_ids: ['task-2'],
      rerun: { summary: 'rerun done' },
      tasks: [],
    });

    const result = await executeSystemTool(
      'repair_task',
      {
        task_id: 'task-2',
        mode: 'repair_and_run',
        include_subtasks: false,
        reason: 'retry once',
      },
      'call-repair-run',
      {
        tenantId: 'tenant-repair',
        chatId: 'chat-repair',
        turnId: 'turn-repair',
        systemPrompt: 'repair prompt',
        client: { provider: 'mock', chat: vi.fn(), chatStream: vi.fn() } as never,
        useSubAgents: true,
        subagentRuntimeSource: 'tenant',
        subagentSessionKey: 'tenant-repair:chat-repair',
      },
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.repairManagedTaskMock).toHaveBeenCalledWith('task-2', expect.objectContaining({
      tenantId: 'tenant-repair',
      chatId: 'chat-repair',
      turnId: 'turn-repair',
      systemPrompt: 'repair prompt',
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'tenant-repair:chat-repair',
      includeSubtasks: false,
      reason: 'retry once',
      rerun: true,
    }));
  });

  it('rejects invalid modes', async () => {
    const result = await executeSystemTool(
      'repair_task',
      { task_id: 'task-1', mode: 'magic' },
      'call-repair-invalid',
      { tenantId: 'tenant-repair' },
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('"mode" must be one of');
  });
});
