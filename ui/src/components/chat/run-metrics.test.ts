import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/types";
import { mergeRunTimeline, projectRunPresentation, timelineIdentityKey } from "./run-metrics";

function task(status: "running" | "completed", timestamp: number, seq?: number): TimelineItem {
  return {
    type: "task_update",
    timestamp,
    turnId: "turn-1",
    ...(seq == null ? {} : { seq }),
    data: { id: `task-${status}-${timestamp}`, task_id: "phase-1", title: "Research", status, timestamp, turnId: "turn-1", ...(seq == null ? {} : { seq }) },
  };
}

describe("run presentation projection", () => {
  it("never lets stale live running state regress a completed REST snapshot", () => {
    const merged = mergeRunTimeline([task("completed", 20, 2)], [task("running", 10)], new Set(["turn-1"]));
    expect(merged).toHaveLength(1);
    expect((merged[0].data as { status: string }).status).toBe("completed");
  });

  it("lets a later terminal live frame replace a stale running REST snapshot", () => {
    const merged = mergeRunTimeline([task("running", 10, 1)], [task("completed", 20, 2)], new Set(["turn-1"]));
    expect(merged).toHaveLength(1);
    expect((merged[0].data as { status: string }).status).toBe("completed");
  });

  it("uses nested turn identity, latest task state, safe reasoning, and product outputs", () => {
    const items: TimelineItem[] = [
      { type: "plan_started", timestamp: 1, data: { plan_id: "p1", goal: "Report", phases: [{ taskId: "phase-1", title: "Research", dependsOn: [] }], timestamp: 1, turnId: "turn-1" } },
      task("running", 2),
      task("completed", 3),
      { type: "message", timestamp: 4, data: { id: "m1", role: "assistant", content: "", timestamp: 4, turnId: "turn-1", reasoning: { provider: "test", hasPrivateReasoning: true, streaming: false, startedAt: 3, completedAt: 4 } } },
      { type: "artifact", timestamp: 5, data: { id: "workspace", title: "Notes", status: "completed", data: { role: "workspace" }, timestamp: 5, turnId: "turn-1" } },
      { type: "artifact", timestamp: 6, data: { id: "output", title: "Report", status: "completed", data: { role: "primary" }, timestamp: 6, turnId: "turn-1" } },
    ];
    const model = projectRunPresentation(new Set(["turn-1"]), items);
    expect(model.progress).toEqual({ completed: 1, total: 1 });
    expect(model.reasoning).toEqual([expect.objectContaining({ hasPrivateReasoning: true })]);
    expect(model.reasoning[0]).not.toHaveProperty("raw");
    expect(model.artifacts.map((artifact) => artifact.id)).toEqual(["workspace", "output"]);
    expect(timelineIdentityKey(items[0])).toBe("plan:turn-1:p1");
  });
});
