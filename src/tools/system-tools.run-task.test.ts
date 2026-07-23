import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  runManagedTaskMock: vi.fn(),
}));

vi.mock('../core/task-execution.js', () => ({
  runManagedTask: hoisted.runManagedTaskMock,
}));

import { executeSystemTool } from './system-tools.js';

describe('tools/system-tools run_task', () => {
  it('forwards runtime context to runManagedTask', async () => {
    hoisted.runManagedTaskMock.mockResolvedValueOnce({
      root_task_id: 'task-1',
      scope_task_ids: ['task-1'],
      scope_task_count: 1,
      summary: 'done',
      tasks: [],
    });

    const result = await executeSystemTool(
      'run_task',
      { task_id: 'task-1', include_subtasks: false },
      'call-run-task',
      {
        tenantId: 'tenant-run',
        chatId: 'chat-run',
        turnId: 'turn-run',
        systemPrompt: 'system prompt',
        client: { provider: 'mock', chat: vi.fn(), chatStream: vi.fn() } as never,
        useSubAgents: true,
        subagentRuntimeSource: 'tenant',
        subagentSessionKey: 'tenant-run:chat-run',
      },
    );

    expect(result?.is_error).toBe(false);
    expect(hoisted.runManagedTaskMock).toHaveBeenCalledWith('task-1', expect.objectContaining({
      tenantId: 'tenant-run',
      chatId: 'chat-run',
      turnId: 'turn-run',
      systemPrompt: 'system prompt',
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'tenant-run:chat-run',
      includeSubtasks: false,
    }));
  });

  it('rejects invalid include_subtasks types', async () => {
    const result = await executeSystemTool(
      'run_task',
      { task_id: 'task-1', include_subtasks: 'yes' },
      'call-run-task-invalid',
      { tenantId: 'tenant-run' },
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('"include_subtasks" must be a boolean');
  });
});
