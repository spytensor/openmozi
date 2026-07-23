import { describe, expect, it } from "vitest";
import type { TaskUpdate, ToolEvent } from "@/types";
import { buildTaskTree, taskNodeState, type TaskGroupNode } from "./task-tree";

function task(
  task_id: string,
  status: TaskUpdate["status"],
  timestamp: number,
  extra: Partial<TaskUpdate> = {},
): TaskUpdate {
  return { id: `t-${task_id}-${timestamp}`, task_id, title: task_id, status, timestamp, ...extra };
}

function tool(id: string, taskId: string | undefined, timestamp: number): ToolEvent {
  return { id, callId: id, taskId, tool: "shell_exec", phase: "end", status: "success", timestamp };
}

function groups(nodes: ReturnType<typeof buildTaskTree>["roots"]): TaskGroupNode[] {
  return nodes.filter((n): n is TaskGroupNode => n.kind === "task");
}

describe("task-tree — nested task-timeline model (Issue #624)", () => {
  it("nests subtasks under their plan root and tools under their subtask", () => {
    const tasks = [
      task("root", "running", 100),
      task("sub-a", "completed", 101, { parentTaskId: "root" }),
      task("sub-b", "running", 102, { parentTaskId: "root" }),
    ];
    const tools = [tool("tool-a1", "sub-a", 103), tool("tool-b1", "sub-b", 104)];

    const tree = buildTaskTree(tasks, tools);
    expect(tree.hasHierarchy).toBe(true);

    const roots = groups(tree.roots);
    expect(roots).toHaveLength(1);
    expect(roots[0].taskId).toBe("root");

    const children = groups(roots[0].children);
    expect(children.map((c) => c.taskId)).toEqual(["sub-a", "sub-b"]);

    const subA = children[0];
    expect(subA.children).toHaveLength(1);
    expect(subA.children[0].kind).toBe("tool");
    expect(subA.children[0].kind === "tool" && subA.children[0].tool.id).toBe("tool-a1");
  });

  it("keeps concurrent subtasks as distinct nodes (never merges)", () => {
    const tasks = [
      task("root", "running", 100),
      task("sub-a", "running", 101, { parentTaskId: "root" }),
      task("sub-b", "running", 101, { parentTaskId: "root" }),
    ];
    const tree = buildTaskTree(tasks, []);
    const children = groups(groups(tree.roots)[0].children);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((c) => c.taskId))).toEqual(new Set(["sub-a", "sub-b"]));
  });

  it("preserves chronology within a relationship", () => {
    const tasks = [task("root", "running", 100)];
    // Tools arrive out of chronological order in the array.
    const tools = [tool("late", "root", 200), tool("early", "root", 150)];
    const tree = buildTaskTree(tasks, tools);
    const rootChildren = groups(tree.roots)[0].children;
    expect(rootChildren.map((c) => (c.kind === "tool" ? c.tool.id : c.key))).toEqual(["early", "late"]);
  });

  it("leaves a tool with no matching task at turn level", () => {
    const tasks = [task("root", "running", 100), task("sub", "running", 101, { parentTaskId: "root" })];
    const tools = [tool("orphan", "ghost-task", 102), tool("owned", "sub", 103)];
    const tree = buildTaskTree(tasks, tools);
    const rootToolLeaves = tree.roots.filter((n) => n.kind === "tool");
    expect(rootToolLeaves).toHaveLength(1);
    expect(rootToolLeaves[0].kind === "tool" && rootToolLeaves[0].tool.id).toBe("orphan");
  });

  it("treats an unknown/self parent as a root, never stranding a node", () => {
    const tasks = [
      task("a", "running", 100, { parentTaskId: "a" }), // self-reference
      task("b", "running", 101, { parentTaskId: "missing" }), // dangling parent
    ];
    const tree = buildTaskTree(tasks, []);
    expect(groups(tree.roots).map((g) => g.taskId).sort()).toEqual(["a", "b"]);
  });

  it("keeps every node reachable when malformed parents form a multi-node cycle", () => {
    const tasks = [
      task("a", "running", 100, { parentTaskId: "b" }),
      task("b", "running", 101, { parentTaskId: "a" }),
    ];
    expect(groups(buildTaskTree(tasks, []).roots).map((group) => group.taskId).sort()).toEqual(["a", "b"]);
  });

  it("returns flat tools with hasHierarchy=false when there are no tasks", () => {
    const tree = buildTaskTree([], [tool("t1", undefined, 100)]);
    expect(tree.hasHierarchy).toBe(false);
    expect(tree.roots).toHaveLength(1);
  });

  it("ignores turn-lifecycle marker tasks", () => {
    const tasks = [
      task("turn_x:working", "running", 100, { userStatus: "working" }),
      task("real", "running", 101),
    ];
    const tree = buildTaskTree(tasks, []);
    expect(groups(tree.roots).map((g) => g.taskId)).toEqual(["real"]);
  });

  describe("taskNodeState — truthful queued/running/succeeded/failed/cancelled", () => {
    it("maps cancelled from rawStatus even though status collapsed to failed", () => {
      expect(taskNodeState(task("x", "failed", 1, { rawStatus: "task_cancelled" }))).toBe("cancelled");
      expect(taskNodeState(task("x", "failed", 1, { rawStatus: "cancelled" }))).toBe("cancelled");
    });
    it("maps the terminal + active states", () => {
      expect(taskNodeState(task("x", "completed", 1))).toBe("succeeded");
      expect(taskNodeState(task("x", "failed", 1, { rawStatus: "task_failed" }))).toBe("failed");
      expect(taskNodeState(task("x", "running", 1))).toBe("running");
    });
    it("treats a queued/created pending task as queued", () => {
      expect(taskNodeState(task("x", "pending", 1, { rawStatus: "dag_created" }))).toBe("queued");
      expect(taskNodeState(task("x", "pending", 1, { userStatus: "checking" }))).toBe("queued");
    });
  });
});
