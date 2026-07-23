import type { TaskUpdate, ToolEvent } from "@/types";
import { isTurnLifecycleTask } from "./execution";

/**
 * Nested task-timeline model (Issue #624).
 * -----------------------------------------
 * A pure reducer that turns a turn's flat task/tool events into a nested tree of
 * task groups so the UI can render plans, sequential/concurrent subtasks,
 * delegated workers, and their tools under the owning parent instead of as flat
 * siblings.
 *
 * Ownership is reconstructed from explicit identifiers already carried end to end
 * (producer → WS → persistence → restore → reducer, see Issue #624):
 *  - a task nests under `parentTaskId` when that parent is also a task in this
 *    turn (plan root → subtask); otherwise it is a top-level group;
 *  - a tool nests under the task whose `taskId` it carries; a tool with no
 *    matching task node stays at turn level (the Brain's own top-level tools).
 *
 * Contract:
 *  - Chronology is preserved within every relationship: siblings sort by their
 *    first-seen timestamp, ties broken by original order — nothing is reordered
 *    for cosmetics.
 *  - Concurrent children never merge: every distinct `task_id` is its own node,
 *    keyed by id, so two subtasks running at once stay separate.
 *  - States are truthful: queued / running / succeeded / failed / cancelled are
 *    derived from the real `status` + `rawStatus`, never invented, and a failed
 *    or cancelled node is always present (never pruned).
 */

export type TaskNodeState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface TaskToolLeaf {
  kind: "tool";
  key: string;
  tool: ToolEvent;
  timestamp: number;
}

export interface TaskGroupNode {
  kind: "task";
  key: string;
  taskId: string;
  task: TaskUpdate;
  state: TaskNodeState;
  timestamp: number;
  /** Subtasks and tools owned by this task, chronologically ordered. */
  children: TaskTreeNode[];
}

export type TaskTreeNode = TaskGroupNode | TaskToolLeaf;

export interface TaskTree {
  /** Top-level task groups and turn-level tools, chronologically ordered. */
  roots: TaskTreeNode[];
  /** True when at least one real (non-lifecycle) task group exists. */
  hasHierarchy: boolean;
}

function isCancelledRaw(rawStatus?: string): boolean {
  return typeof rawStatus === "string" && /cancel/i.test(rawStatus);
}

function isQueuedRaw(rawStatus?: string): boolean {
  return rawStatus === "queued" || rawStatus === "dag_created";
}

/**
 * Truthful node state from the emitted status. The transport collapses cancelled
 * → failed in the 4-state `status`, so `rawStatus` is consulted first to keep a
 * user-cancelled task distinct from a real failure.
 */
export function taskNodeState(task: TaskUpdate): TaskNodeState {
  if (isCancelledRaw(task.rawStatus)) return "cancelled";
  switch (task.status) {
    case "failed":
      return "failed";
    case "completed":
      return "succeeded";
    case "running":
      return "running";
    case "pending":
      return isQueuedRaw(task.rawStatus) || task.userStatus === "checking" || !task.userStatus
        ? "queued"
        : "running";
    default:
      return "running";
  }
}

/** Latest row per task_id, dropping turn-lifecycle markers (session-state noise). */
function dedupeRealTasks(tasks: TaskUpdate[]): TaskUpdate[] {
  const byId = new Map<string, TaskUpdate>();
  for (const task of tasks) {
    if (isTurnLifecycleTask(task)) continue;
    const existing = byId.get(task.task_id);
    if (!existing) {
      byId.set(task.task_id, task);
      continue;
    }
    byId.set(task.task_id, { ...task, timestamp: Math.min(existing.timestamp, task.timestamp) });
  }
  return [...byId.values()];
}

/** Latest event per callId so a start+end pair renders as one leaf. */
function dedupeTools(tools: ToolEvent[]): ToolEvent[] {
  const byCall = new Map<string, ToolEvent>();
  tools.forEach((tool, index) => {
    const key = tool.callId || `${tool.id}-${index}`;
    const existing = byCall.get(key);
    if (!existing) {
      byCall.set(key, tool);
      return;
    }
    if (tool.phase === "end" || tool.timestamp > existing.timestamp) {
      byCall.set(key, { ...tool, timestamp: Math.min(existing.timestamp, tool.timestamp) });
    }
  });
  return [...byCall.values()];
}

function sortByChronology(nodes: TaskTreeNode[]): TaskTreeNode[] {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((a, b) => a.node.timestamp - b.node.timestamp || a.index - b.index)
    .map((entry) => entry.node);
}

/**
 * Build the nested task tree for one execution block. Pure; safe to call for a
 * turn with no tasks (returns tools as flat roots, `hasHierarchy: false`).
 */
export function buildTaskTree(tasks: TaskUpdate[], tools: ToolEvent[]): TaskTree {
  const realTasks = dedupeRealTasks(tasks);
  const nodeById = new Map<string, TaskGroupNode>();
  for (const task of realTasks) {
    nodeById.set(task.task_id, {
      kind: "task",
      key: `task:${task.task_id}`,
      taskId: task.task_id,
      task,
      state: taskNodeState(task),
      timestamp: task.timestamp,
      children: [],
    });
  }

  const roots: TaskTreeNode[] = [];

  const wouldCreateCycle = (taskId: string, parentId: string): boolean => {
    const visited = new Set<string>([taskId]);
    let current: string | undefined = parentId;
    while (current) {
      if (visited.has(current)) return true;
      visited.add(current);
      current = nodeById.get(current)?.task.parentTaskId;
    }
    return false;
  };

  // Nest task nodes under their parent when the parent is present in this turn;
  // otherwise the task is a top-level group. A self-referential or missing parent
  // never nests, so a cycle can't strand a node off-tree.
  for (const task of realTasks) {
    const node = nodeById.get(task.task_id)!;
    const parentId = task.parentTaskId;
    const parent = parentId && !wouldCreateCycle(task.task_id, parentId) ? nodeById.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Attach tools to the task that owns them (by taskId); unowned tools are the
  // turn's own top-level work and stay at root level.
  for (const tool of dedupeTools(tools)) {
    const owner = tool.taskId ? nodeById.get(tool.taskId) : undefined;
    const leaf: TaskToolLeaf = {
      kind: "tool",
      key: `tool:${tool.id}`,
      tool,
      timestamp: tool.timestamp,
    };
    if (owner) owner.children.push(leaf);
    else roots.push(leaf);
  }

  for (const node of nodeById.values()) node.children = sortByChronology(node.children);

  return { roots: sortByChronology(roots), hasHierarchy: nodeById.size > 0 };
}
