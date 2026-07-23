import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { create, fail, incrementAttempts, resetColumnsEnsured, updateStatus } from '../store/task-dag.js';
import { query as queryEvents } from '../store/events.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getManagedTask } from './task-management.js';

const hoisted = vi.hoisted(() => ({
  runManagedTaskMock: vi.fn(),
  getLatestExternalWorkerJobForTaskMock: vi.fn(),
}));

vi.mock('./task-execution.js', () => ({
  runManagedTask: hoisted.runManagedTaskMock,
}));

vi.mock('../workers/job-state.js', () => ({
  getLatestExternalWorkerJobForTask: hoisted.getLatestExternalWorkerJobForTaskMock,
}));

import { diagnoseManagedTaskRepair, repairManagedTask } from './task-repair.js';

let tmpDir: string;

beforeAll(() => {
  resetColumnsEnsured();
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

afterEach(() => {
  hoisted.runManagedTaskMock.mockReset();
  hoisted.getLatestExternalWorkerJobForTaskMock.mockReset().mockReturnValue(null);
});

describe('core/task-repair', () => {
  it('diagnoses timeout failures as repairable', () => {
    const tenantId = 'task-repair-timeout';
    const root = create({ tenant_id: tenantId, title: 'Timeout task', objective: 'Slow work' });
    fail(root.id, 'Task timed out after 30000ms', tenantId);

    const diagnosis = diagnoseManagedTaskRepair(root.id, tenantId);
    expect(diagnosis.category).toBe('timed_out');
    expect(diagnosis.repairable).toBe(true);
    expect(diagnosis.auto_repairable).toBe(true);
    expect(diagnosis.suggested_action).toBe('repair_and_rerun');
  });

  it('diagnoses missing environment blocks as not repairable', () => {
    const tenantId = 'task-repair-env';
    const root = create({ tenant_id: tenantId, title: 'Env task', objective: 'Needs env' });
    updateStatus(root.id, 'blocked', tenantId, {
      reason: 'Task blocked: missing environment variables FOO_API_KEY, BAR_TOKEN',
    });

    const diagnosis = diagnoseManagedTaskRepair(root.id, tenantId);
    expect(diagnosis.category).toBe('missing_environment');
    expect(diagnosis.repairable).toBe(false);
    expect(diagnosis.missing_env_keys).toEqual(['FOO_API_KEY', 'BAR_TOKEN']);
  });

  it('resets failed root and dependent tasks before rerun', async () => {
    const tenantId = 'task-repair-reset';
    const root = create({ tenant_id: tenantId, title: 'Root task', objective: 'Primary work' });
    const child = create({
      tenant_id: tenantId,
      title: 'Child task',
      objective: 'Dependent work',
      depends_on: [root.id],
    });

    fail(root.id, 'Task timed out after 15000ms', tenantId);

    const result = await repairManagedTask(root.id, {
      tenantId,
      reason: 'Retry after timeout',
      rerun: false,
    });

    expect(result.reset_task_ids).toEqual(expect.arrayContaining([root.id, child.id]));
    expect(getManagedTask(root.id, tenantId)?.task.status).toBe('ready');
    expect(getManagedTask(child.id, tenantId)?.task.status).toBe('pending');
    expect(hoisted.runManagedTaskMock).not.toHaveBeenCalled();
  });

  it('reruns after repair when requested', async () => {
    const tenantId = 'task-repair-rerun';
    const root = create({ tenant_id: tenantId, title: 'Rerun task', objective: 'Run again' });
    incrementAttempts(root.id, tenantId);
    incrementAttempts(root.id, tenantId);
    incrementAttempts(root.id, tenantId);
    fail(root.id, 'Runtime crashed unexpectedly', tenantId);

    hoisted.runManagedTaskMock.mockImplementationOnce(async () => {
      expect(getManagedTask(root.id, tenantId)?.task.attempts).toBe(0);
      return {
        root_task_id: root.id,
        scope_task_ids: [root.id],
        scope_task_count: 1,
        summary: 'rerun summary',
        tasks: [],
      };
    });

    const result = await repairManagedTask(root.id, {
      tenantId,
      rerun: true,
      chatId: 'chat-rerun',
      turnId: 'turn-rerun',
      systemPrompt: '# SOUL.md — Runtime Identity\nrepair system',
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'task-repair-rerun:chat-rerun',
    });

    expect(hoisted.runManagedTaskMock).toHaveBeenCalledWith(root.id, expect.objectContaining({
      tenantId,
      chatId: 'chat-rerun',
      turnId: 'turn-rerun',
      systemPrompt: '# SOUL.md — Runtime Identity\nrepair system',
      useSubAgents: true,
      subagentRuntimeSource: 'tenant',
      subagentSessionKey: 'task-repair-rerun:chat-rerun',
    }));
    expect(result.rerun?.summary).toBe('rerun summary');
    const repairEvent = queryEvents('task', root.id, tenantId)
      .find((event) => event.event_type === 'task_repair_reset');
    expect(repairEvent?.payload).toEqual(expect.objectContaining({
      previous_attempts: 3,
      next_attempts: 0,
    }));
  });

  it('renews retry budgets for every unfinished task in an explicit rerun scope', async () => {
    const tenantId = 'task-repair-scope-budget';
    const root = create({ tenant_id: tenantId, title: 'Failed root', objective: 'Run plan' });
    const child = create({
      tenant_id: tenantId,
      parent_task_id: root.id,
      title: 'Stranded child',
      objective: 'Finish child',
      depends_on: [root.id],
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      incrementAttempts(root.id, tenantId);
      incrementAttempts(child.id, tenantId);
    }
    fail(root.id, 'Runtime crashed unexpectedly', tenantId);
    updateStatus(child.id, 'ready', tenantId, { reason: 'stranded after crash' });

    hoisted.runManagedTaskMock.mockImplementationOnce(async () => {
      expect(getManagedTask(root.id, tenantId)?.task.attempts).toBe(0);
      expect(getManagedTask(child.id, tenantId)?.task.attempts).toBe(0);
      expect(getManagedTask(child.id, tenantId)?.task.status).toBe('ready');
      return {
        root_task_id: root.id,
        scope_task_ids: [root.id, child.id],
        scope_task_count: 2,
        summary: 'scope rerun summary',
        tasks: [],
      };
    });

    await repairManagedTask(root.id, {
      tenantId,
      rerun: true,
      systemPrompt: '# SOUL.md — Runtime Identity\nrepair system',
      useSubAgents: false,
    });

    const childBudgetEvent = queryEvents('task', child.id, tenantId)
      .find((event) => event.event_type === 'task_repair_budget_reset');
    expect(childBudgetEvent?.payload).toEqual(expect.objectContaining({
      previous_attempts: 3,
      next_attempts: 0,
    }));
  });

  it('leaves a failed task untouched when repair-and-run has no delegation prompt', async () => {
    const tenantId = 'task-repair-missing-prompt';
    const root = create({ tenant_id: tenantId, title: 'Do not reset', objective: 'preserve failure' });
    fail(root.id, 'Runtime crashed unexpectedly', tenantId);

    await expect(repairManagedTask(root.id, { tenantId, rerun: true })).rejects.toThrow(
      'delegation system prompt is missing or invalid',
    );
    expect(getManagedTask(root.id, tenantId)?.task.status).toBe('failed');
    expect(hoisted.runManagedTaskMock).not.toHaveBeenCalled();
  });

  it('prefers managed worker verify failures over generic task status', () => {
    const tenantId = 'task-repair-worker';
    const root = create({ tenant_id: tenantId, title: 'Worker task', objective: 'Delegated work' });
    updateStatus(root.id, 'failed', tenantId, { reason: 'worker failed verification' });

    hoisted.getLatestExternalWorkerJobForTaskMock.mockReturnValue({
      status: 'failed',
      failure_category: 'verify_failed',
      last_error: 'Managed worker verification failed',
      verify_report: { summary: 'Verifier rejected output' },
      result_envelope: null,
    });

    const diagnosis = diagnoseManagedTaskRepair(root.id, tenantId);
    expect(diagnosis.category).toBe('worker_verify_failed');
    expect(diagnosis.repairable).toBe(false);
    expect(diagnosis.source).toBe('worker_job');
  });
});
