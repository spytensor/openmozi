/**
 * DAG Graph Utilities — dependency resolution and topological ordering.
 *
 * Pure graph operations used by dag-executor.ts. No I/O, no side effects.
 */

import type { TaskRecord } from '../store/task-dag.js';
import { getDependencies } from '../store/task-dag.js';

export function buildDependencyMap(
  tasks: TaskRecord[],
  taskById: Map<string, TaskRecord>,
): Map<string, string[]> {
  const map = new Map<string, string[]>();

  for (const task of tasks) {
    const depIds = getDependencies(task.id, task.tenant_id)
      .filter(depId => taskById.has(depId));
    map.set(task.id, depIds);
  }

  return map;
}

export function buildDependentsMap(
  tasks: TaskRecord[],
  dependencies: Map<string, string[]>,
): Map<string, string[]> {
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    dependents.set(task.id, []);
  }

  for (const task of tasks) {
    const deps = dependencies.get(task.id) ?? [];
    for (const depId of deps) {
      dependents.get(depId)?.push(task.id);
    }
  }

  return dependents;
}

export function topologicalOrder(
  tasks: TaskRecord[],
  dependencies: Map<string, string[]>,
  dependents: Map<string, string[]>,
): string[] {
  const inDegree = new Map<string, number>();
  const taskById = new Map(tasks.map(task => [task.id, task]));

  for (const task of tasks) {
    inDegree.set(task.id, (dependencies.get(task.id) ?? []).length);
  }

  const queue: string[] = [];
  for (const task of tasks) {
    if ((inDegree.get(task.id) ?? 0) === 0) {
      queue.push(task.id);
    }
  }

  const ordered: string[] = [];
  while (queue.length > 0) {
    queue.sort((a, b) => {
      const ta = taskById.get(a)!;
      const tb = taskById.get(b)!;
      if (ta.priority !== tb.priority) {
        return ta.priority - tb.priority;
      }
      return ta.created_at.localeCompare(tb.created_at);
    });

    const taskId = queue.shift()!;
    ordered.push(taskId);

    for (const downstreamId of dependents.get(taskId) ?? []) {
      const nextDegree = (inDegree.get(downstreamId) ?? 0) - 1;
      inDegree.set(downstreamId, nextDegree);
      if (nextDegree === 0) {
        queue.push(downstreamId);
      }
    }
  }

  if (ordered.length !== tasks.length) {
    throw new Error('Cycle detected in task DAG');
  }

  return ordered;
}
