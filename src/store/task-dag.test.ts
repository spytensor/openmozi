import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  create, getById, listTasks, getReady, updateStatus, assign,
  updateTask, complete, fail, cancel, getDependencies, getDownstreamTasks,
  topologicalSort, incrementAttempts, resetAttempts, resetColumnsEnsured,
} from './task-dag.js';
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

describe('store/task-dag', () => {
  // ---- CRUD ----

  it('create a task without dependencies → status ready', () => {
    const t = create({ title: 'step1', objective: 'do A' });
    expect(t.id).toBeTruthy();
    expect(t.title).toBe('step1');
    expect(t.status).toBe('ready');
    expect(t.priority).toBe(0);
    expect(t.attempts).toBe(0);
  });

  it('create a task with dependencies → status pending', () => {
    const t1 = create({ title: 'dep1', objective: 'x' });
    const t2 = create({ title: 'dep2', objective: 'y', depends_on: [t1.id] });
    expect(t2.status).toBe('pending');
    const deps = getDependencies(t2.id);
    expect(deps).toContain(t1.id);
  });

  it('getById returns null for unknown id', () => {
    expect(getById('nonexistent')).toBeNull();
  });

  it('listTasks returns tasks', () => {
    const tasks = listTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('listTasks filters by status', () => {
    const ready = listTasks({ status: 'ready' });
    expect(ready.every(t => t.status === 'ready')).toBe(true);
  });

  it('updateStatus changes task status', () => {
    const t = create({ title: 'status-test', objective: 'test' });
    updateStatus(t.id, 'running');
    const updated = getById(t.id);
    expect(updated!.status).toBe('running');
  });

  it('updateTask patches metadata fields without changing status', () => {
    const t = create({ title: 'patch-test', objective: 'draft' });
    const updated = updateTask(t.id, {
      title: 'patch-test-v2',
      priority: 4,
      tags: ['task', 'v2'],
    });
    expect(updated!.title).toBe('patch-test-v2');
    expect(updated!.priority).toBe(4);
    expect(updated!.tags).toEqual(['task', 'v2']);
    expect(updated!.status).toBe('ready');
  });

  it('assign sets agent and status', () => {
    const t = create({ title: 'assign-test', objective: 'test' });
    assign(t.id, 'agent-123');
    const updated = getById(t.id);
    expect(updated!.status).toBe('assigned');
    expect(updated!.assigned_agent).toBe('agent-123');
  });

  it('incrementAttempts increases attempt count', () => {
    const t = create({ title: 'attempt-test', objective: 'test' });
    expect(t.attempts).toBe(0);
    incrementAttempts(t.id);
    incrementAttempts(t.id);
    const updated = getById(t.id);
    expect(updated!.attempts).toBe(2);
  });

  it('resetAttempts starts a fresh explicit repair budget and returns the previous count', () => {
    const t = create({ title: 'attempt-reset-test', objective: 'test' });
    incrementAttempts(t.id);
    incrementAttempts(t.id);

    expect(resetAttempts(t.id)).toBe(2);
    expect(getById(t.id)!.attempts).toBe(0);
  });

  // ---- DAG dependency propagation ----

  it('complete propagates readiness to downstream tasks', () => {
    const t1 = create({ title: 'dag-a', objective: 'do A' });
    const t2 = create({ title: 'dag-b', objective: 'do B', depends_on: [t1.id] });
    const t3 = create({ title: 'dag-c', objective: 'do C', depends_on: [t1.id] });
    const t4 = create({ title: 'dag-d', objective: 'do D', depends_on: [t2.id, t3.id] });

    expect(t1.status).toBe('ready');
    expect(t2.status).toBe('pending');
    expect(t3.status).toBe('pending');
    expect(t4.status).toBe('pending');

    // Complete t1 → t2 and t3 become ready
    const newlyReady = complete(t1.id);
    const readyTitles = newlyReady.map(t => t.title).sort();
    expect(readyTitles).toEqual(['dag-b', 'dag-c']);

    // t4 still pending (waiting for t2 AND t3)
    const t4After = getById(t4.id);
    expect(t4After!.status).toBe('pending');

    // Complete t2 → t4 still pending (needs t3)
    complete(t2.id);
    const t4After2 = getById(t4.id);
    expect(t4After2!.status).toBe('pending');

    // Complete t3 → t4 becomes ready
    const lastReady = complete(t3.id);
    expect(lastReady.map(t => t.title)).toEqual(['dag-d']);
  });

  // ---- Failure handling ----

  it('fail with fail_fast cascades to downstream', () => {
    const t1 = create({ title: 'ff-a', objective: 'a' });
    const t2 = create({ title: 'ff-b', objective: 'b', depends_on: [t1.id], on_dep_failure: 'fail_fast' });

    fail(t1.id, 'test failure');
    const t1After = getById(t1.id);
    expect(t1After!.status).toBe('failed');

    const t2After = getById(t2.id);
    expect(t2After!.status).toBe('failed');
  });

  it('fail with continue policy cancels downstream but does not cascade', () => {
    const t1 = create({ title: 'cont-a', objective: 'a' });
    const t2 = create({ title: 'cont-b', objective: 'b', depends_on: [t1.id], on_dep_failure: 'continue' });

    fail(t1.id, 'test failure');
    const t2After = getById(t2.id);
    expect(t2After!.status).toBe('cancelled');
  });

  it('fail with fallback policy marks downstream as ready', () => {
    const t1 = create({ title: 'fb-a', objective: 'a' });
    const t2 = create({ title: 'fb-b', objective: 'b', depends_on: [t1.id], on_dep_failure: 'fallback' });

    fail(t1.id, 'test failure');
    const t2After = getById(t2.id);
    expect(t2After!.status).toBe('ready');
  });

  // ---- Cancel ----

  it('cancel cascades to pending downstream tasks', () => {
    const t1 = create({ title: 'can-a', objective: 'a' });
    const t2 = create({ title: 'can-b', objective: 'b', depends_on: [t1.id] });

    cancel(t1.id, 'default', 'user requested stop');
    expect(getById(t1.id)!.status).toBe('cancelled');
    expect(getById(t2.id)!.status).toBe('cancelled');
  });

  // ---- Topological sort ----

  it('topologicalSort returns tasks in dependency order', () => {
    // Create a fresh tenant to isolate from previous tests
    const tenant = 'topo-test';
    const a = create({ title: 'topo-a', objective: 'a', tenant_id: tenant });
    const b = create({ title: 'topo-b', objective: 'b', depends_on: [a.id], tenant_id: tenant });
    const c = create({ title: 'topo-c', objective: 'c', depends_on: [a.id], tenant_id: tenant });
    const d = create({ title: 'topo-d', objective: 'd', depends_on: [b.id, c.id], tenant_id: tenant });

    const sorted = topologicalSort(tenant);
    const titles = sorted.map(t => t.title);

    // a must come before b and c; b and c must come before d
    expect(titles.indexOf('topo-a')).toBeLessThan(titles.indexOf('topo-b'));
    expect(titles.indexOf('topo-a')).toBeLessThan(titles.indexOf('topo-c'));
    expect(titles.indexOf('topo-b')).toBeLessThan(titles.indexOf('topo-d'));
    expect(titles.indexOf('topo-c')).toBeLessThan(titles.indexOf('topo-d'));
  });

  // ---- Dependency validation ----

  it('create rejects invalid dependency references', () => {
    expect(() => create({ title: 'bad-dep', objective: 'x', depends_on: ['nonexistent-id'] }))
      .toThrow('Dependency task not found');
  });

  // ---- Constraints & metadata ----

  it('create stores constraints and tags', () => {
    const t = create({
      title: 'meta-test',
      objective: 'test',
      constraints: { token_budget: 5000, timeout_seconds: 60 },
      tags: ['test', 'phase2'],
      priority: 5,
    });

    expect(t.constraints.token_budget).toBe(5000);
    expect(t.constraints.timeout_seconds).toBe(60);
    expect(t.tags).toEqual(['test', 'phase2']);
    expect(t.priority).toBe(5);
  });

  // ---- getDownstreamTasks ----

  it('getDownstreamTasks returns correct tasks', () => {
    const tenant = 'downstream-test';
    const parent = create({ title: 'ds-parent', objective: 'p', tenant_id: tenant });
    create({ title: 'ds-child1', objective: 'c1', depends_on: [parent.id], tenant_id: tenant });
    create({ title: 'ds-child2', objective: 'c2', depends_on: [parent.id], tenant_id: tenant });

    const downstream = getDownstreamTasks(parent.id, tenant);
    expect(downstream.length).toBe(2);
    expect(downstream.map(t => t.title).sort()).toEqual(['ds-child1', 'ds-child2']);
  });
});
