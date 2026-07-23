import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createManagedTask,
  getManagedTask,
  listManagedTasks,
  updateManagedTask,
} from './task-management.js';
import { resetColumnsEnsured } from '../store/task-dag.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  resetColumnsEnsured();
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('core/task-management', () => {
  it('creates a managed task with dependency and parent detail', () => {
    const parent = createManagedTask({
      tenant_id: 'task-mgmt-parent',
      title: 'Parent task',
      objective: 'Own the workstream',
    });

    const child = createManagedTask({
      tenant_id: 'task-mgmt-parent',
      parent_task_id: parent.task.id,
      title: 'Child task',
      objective: 'Implement the workstream',
      depends_on: [parent.task.id],
      tags: ['phase1'],
    });

    expect(child.task.parent_task_id).toBe(parent.task.id);
    expect(child.dependencies).toEqual([
      expect.objectContaining({ id: parent.task.id, title: 'Parent task' }),
    ]);

    const parentDetail = getManagedTask(parent.task.id, 'task-mgmt-parent');
    expect(parentDetail?.children).toEqual([
      expect.objectContaining({ id: child.task.id, title: 'Child task' }),
    ]);
    expect(parentDetail?.recent_events.some((event) => event.event_type === 'task_created')).toBe(true);
  });

  it('lists tasks with search/tag filters and blocked_by context', () => {
    const tenantId = 'task-mgmt-list';
    const setup = createManagedTask({
      tenant_id: tenantId,
      title: 'Prepare environment',
      objective: 'Install dependencies',
      tags: ['setup'],
    });
    createManagedTask({
      tenant_id: tenantId,
      title: 'Ship feature',
      objective: 'Use the prepared environment',
      depends_on: [setup.task.id],
      tags: ['feature'],
    });

    const byTag = listManagedTasks({ tenant_id: tenantId, tag: 'feature' });
    expect(byTag).toHaveLength(1);
    expect(byTag[0]?.blocked_by).toEqual([
      expect.objectContaining({ id: setup.task.id, title: 'Prepare environment', status: 'ready' }),
    ]);

    const bySearch = listManagedTasks({ tenant_id: tenantId, search: 'prepared environment' });
    expect(bySearch).toHaveLength(1);
    expect(bySearch[0]?.title).toBe('Ship feature');
  });

  it('patches task metadata and records blocking reason', () => {
    const tenantId = 'task-mgmt-update';
    const created = createManagedTask({
      tenant_id: tenantId,
      title: 'Draft implementation',
      objective: 'First pass',
    });

    const result = updateManagedTask({
      tenant_id: tenantId,
      task_id: created.task.id,
      patch: {
        title: 'Draft implementation v2',
        priority: 3,
        tags: ['iteration', 'v2'],
      },
      status: 'blocked',
      reason: 'Waiting for operator decision',
    });

    expect(result.task.task.title).toBe('Draft implementation v2');
    expect(result.task.task.priority).toBe(3);
    expect(result.task.task.tags).toEqual(['iteration', 'v2']);
    expect(result.task.task.status).toBe('blocked');
    expect(result.task.recent_events.some((event) => event.event_type === 'task_updated')).toBe(true);
    expect(result.task.recent_events.some((event) => event.event_type === 'task_status_changed')).toBe(true);
  });

  it('completes a task and reports newly ready downstream tasks', () => {
    const tenantId = 'task-mgmt-complete';
    const prep = createManagedTask({
      tenant_id: tenantId,
      title: 'Prepare API contract',
      objective: 'Define interfaces',
    });
    const impl = createManagedTask({
      tenant_id: tenantId,
      title: 'Implement API contract',
      objective: 'Build against the interface',
      depends_on: [prep.task.id],
    });

    const result = updateManagedTask({
      tenant_id: tenantId,
      task_id: prep.task.id,
      status: 'completed',
    });

    expect(result.task.task.status).toBe('completed');
    expect(result.newly_ready_tasks).toEqual([
      expect.objectContaining({ id: impl.task.id, title: 'Implement API contract', status: 'ready' }),
    ]);

    const implDetail = getManagedTask(impl.task.id, tenantId);
    expect(implDetail?.task.status).toBe('ready');
    expect(implDetail?.task.blocked_by).toEqual([]);
  });
});
