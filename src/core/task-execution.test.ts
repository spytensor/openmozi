import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { create, getById, resetColumnsEnsured, updateStatus } from '../store/task-dag.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

const hoisted = vi.hoisted(() => ({
  executeDagMock: vi.fn(),
}));

vi.mock('./dag-executor.js', () => ({
  executeDag: hoisted.executeDagMock,
}));

import { runManagedTask } from './task-execution.js';

let tmpDir: string;

beforeAll(() => {
  resetColumnsEnsured();
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  hoisted.executeDagMock.mockReset().mockResolvedValue('mock task run summary');
});

describe('core/task-execution', () => {
  it('builds execution scope from subtree plus unresolved dependencies', async () => {
    const tenantId = 'task-exec-scope';
    const setup = create({ tenant_id: tenantId, title: 'Setup', objective: 'Prepare environment' });
    const root = create({
      tenant_id: tenantId,
      title: 'Root',
      objective: 'Run main work',
      depends_on: [setup.id],
    });
    const child = create({
      tenant_id: tenantId,
      parent_task_id: root.id,
      title: 'Child',
      objective: 'Follow-up work',
      depends_on: [root.id],
    });

    const result = await runManagedTask(root.id, {
      tenantId,
      chatId: 'chat-task-exec',
      systemPrompt: '# SOUL.md — Runtime Identity\nsys prompt',
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'task-exec-scope:chat-task-exec',
    });

    expect(hoisted.executeDagMock).toHaveBeenCalledOnce();
    const [tasks, systemPrompt, chatId, progress, fallbackClient, turnId, options] =
      hoisted.executeDagMock.mock.calls[0] as [Array<{ id: string }>, string, string, unknown, unknown, unknown, Record<string, unknown>];
    expect(new Set(tasks.map((task) => task.id))).toEqual(new Set([setup.id, root.id, child.id]));
    expect(systemPrompt).toBe('# SOUL.md — Runtime Identity\nsys prompt');
    expect(chatId).toBe('chat-task-exec');
    expect(progress).toBeUndefined();
    expect(fallbackClient).toBeUndefined();
    expect(turnId).toBeUndefined();
    expect(options).toMatchObject({
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'task-exec-scope:chat-task-exec',
    });

    expect(result.root_task_id).toBe(root.id);
    expect(result.scope_task_count).toBe(3);
    expect(new Set(result.scope_task_ids)).toEqual(new Set([setup.id, root.id, child.id]));
    expect(result.summary).toBe('mock task run summary');
  });

  it('skips completed dependencies outside the execution scope', async () => {
    const tenantId = 'task-exec-completed';
    const done = create({ tenant_id: tenantId, title: 'Done dependency', objective: 'already finished' });
    updateStatus(done.id, 'completed', tenantId);
    const root = create({
      tenant_id: tenantId,
      title: 'Root after done dependency',
      objective: 'Continue work',
      depends_on: [done.id],
    });

    const result = await runManagedTask(root.id, {
      tenantId,
      systemPrompt: '# SOUL.md — Runtime Identity\ncompleted dependency test',
    });
    const [tasks] = hoisted.executeDagMock.mock.calls[0] as [Array<{ id: string }>];
    expect(tasks.map((task) => task.id)).toEqual([root.id]);
    expect(result.scope_task_ids).toEqual([root.id]);
  });

  it('rejects blocked tasks in the execution scope', async () => {
    const tenantId = 'task-exec-blocked';
    const blockedDep = create({ tenant_id: tenantId, title: 'Blocked dep', objective: 'needs input' });
    updateStatus(blockedDep.id, 'blocked', tenantId, { reason: 'waiting on operator' });
    const root = create({
      tenant_id: tenantId,
      title: 'Blocked root',
      objective: 'Cannot proceed yet',
      depends_on: [blockedDep.id],
    });

    await expect(runManagedTask(root.id, { tenantId })).rejects.toThrow(
      `Execution scope includes blocked task ${blockedDep.id}`,
    );
    expect(hoisted.executeDagMock).not.toHaveBeenCalled();
  });

  it('rejects direct execution of terminal tasks', async () => {
    const tenantId = 'task-exec-terminal';
    const root = create({ tenant_id: tenantId, title: 'Finished task', objective: 'done' });
    updateStatus(root.id, 'completed', tenantId);

    await expect(runManagedTask(root.id, { tenantId })).rejects.toThrow(
      `Task ${root.id} is already completed`,
    );
    expect(hoisted.executeDagMock).not.toHaveBeenCalled();
  });

  it('fails closed before execution when the entry point did not pass a delegation prompt', async () => {
    const tenantId = 'task-exec-missing-prompt';
    const root = create({ tenant_id: tenantId, title: 'Runnable task', objective: 'must not start' });

    await expect(runManagedTask(root.id, { tenantId })).rejects.toThrow('delegation system prompt is missing or invalid');
    expect(hoisted.executeDagMock).not.toHaveBeenCalled();
    expect(getById(root.id, tenantId)?.status).toBe('ready');
  });
});
