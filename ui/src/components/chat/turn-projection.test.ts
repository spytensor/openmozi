import { describe, it, expect } from "vitest";
import type { TimelineItem, TurnEnvelope } from "@/types";
import { canProjectDeterministically, projectLegacyTimeline, projectTimelineByTurn } from "./turn-projection";
import type { ChatRenderItem } from "./execution";

const CAPS = ["timeline_v1"];

let seqCounter = 0;

function userMsg(turnId: string, content: string, seq: number): TimelineItem {
  return { type: "message", timestamp: 1000 + seq, turnId, seq, data: { id: `u-${turnId}-${seq}`, role: "user", content, timestamp: 1000 + seq, turnId, seq } };
}

function assistantMsg(turnId: string, content: string, seq: number, streaming = false): TimelineItem {
  return { type: "message", timestamp: 1000 + seq, turnId, seq, data: { id: `a-${turnId}-${seq}`, role: "assistant", content, timestamp: 1000 + seq, turnId, seq, ...(streaming ? { streaming: true, requestId: `req-${turnId}` } : {}) } };
}

function toolEvent(turnId: string, callId: string, seq: number, opts: { phase?: "start" | "end"; status?: "success" | "error"; error?: string } = {}): TimelineItem {
  const phase = opts.phase ?? "end";
  return {
    type: "tool_event",
    timestamp: 1000 + seq,
    turnId,
    seq,
    data: {
      id: `t-${callId}-${seq}`,
      callId,
      tool: "web_search",
      phase,
      status: opts.status ?? "success",
      turnId,
      seq,
      intent: "look something up",
      error: opts.error,
      elapsed_ms: 1200,
      timestamp: 1000 + seq,
    },
  };
}

function artifact(turnId: string, id: string, seq: number): TimelineItem {
  return {
    type: "artifact",
    timestamp: 1000 + seq,
    turnId,
    seq,
    data: { id, plugin_id: "document_v1", title: "Report", status: "completed", data: {}, timestamp: 1000 + seq, turnId, seq },
  };
}

/** A serializable, order-independent view of what actually renders (excludes the
 *  raw-array `index`, which legitimately tracks input position). */
function renderShape(items: ChatRenderItem[]): unknown[] {
  return items.map((ri) => {
    if (ri.kind === "execution") {
      return {
        kind: "execution",
        turnId: ri.block.turnId,
        status: ri.block.status,
        toolCount: ri.block.toolCount,
        issueCount: ri.block.issueCount,
      };
    }
    const item = ri.item;
    if (item.type === "message") {
      const m = item.data as { role: string; content: string; id: string };
      return { kind: "single", type: "message", role: m.role, id: m.id, content: m.content };
    }
    return { kind: "single", type: item.type, id: (item.data as { id: string }).id };
  });
}

describe("canProjectDeterministically", () => {
  it("requires the timeline_v1 capability", () => {
    const timeline = [userMsg("turn_1", "hi", 1), assistantMsg("turn_1", "hello", 2)];
    expect(canProjectDeterministically(timeline, [])).toBe(false);
    expect(canProjectDeterministically(timeline, null)).toBe(false);
    expect(canProjectDeterministically(timeline, CAPS)).toBe(true);
  });

  it("falls back for a legacy session where a content item has no turn id", () => {
    const legacy: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "x", role: "user", content: "hi", timestamp: 1 } },
      { type: "message", timestamp: 2, data: { id: "y", role: "assistant", content: "yo", timestamp: 2 } },
    ];
    expect(canProjectDeterministically(legacy, CAPS)).toBe(false);
  });

  it("falls back for a mixed session (some rows identified, some not)", () => {
    const mixed: TimelineItem[] = [
      userMsg("turn_1", "hi", 1),
      { type: "message", timestamp: 2, data: { id: "legacy", role: "assistant", content: "old", timestamp: 2 } },
    ];
    expect(canProjectDeterministically(mixed, CAPS)).toBe(false);
  });

  it("exempts client-local system notices from the identity requirement", () => {
    const timeline: TimelineItem[] = [
      userMsg("turn_1", "hi", 1),
      { type: "message", timestamp: 2, data: { id: "sys", role: "system", content: "queued", timestamp: 2 } },
      assistantMsg("turn_1", "hello", 2),
    ];
    expect(canProjectDeterministically(timeline, CAPS)).toBe(true);
  });

  it("returns false for an empty timeline", () => {
    expect(canProjectDeterministically([], CAPS)).toBe(false);
  });
});

describe("projectLegacyTimeline — authoritative terminal compatibility", () => {
  it("does not leave a completed detached-plan handoff spinning when an old artifact is unscoped", () => {
    const foregroundTurn = "turn_1784052584728_hm3d3t";
    const timeline: TimelineItem[] = [
      userMsg(foregroundTurn, "完成长任务", 1),
      {
        type: "task_update",
        timestamp: 1784052596403,
        turnId: foregroundTurn,
        seq: 2,
        data: {
          id: "handoff",
          task_id: "plan-root",
          title: "完成长任务",
          status: "pending",
          rawStatus: "dag_created",
          turnId: foregroundTurn,
          seq: 2,
          timestamp: 1784052596403,
        },
      },
      assistantMsg(foregroundTurn, "已在后台开始执行", 3),
      {
        type: "artifact",
        timestamp: 1784053000000,
        data: { id: "legacy-unscoped", plugin_id: "document_v1", title: "Excel", status: "completed", data: {}, timestamp: 1784053000000 },
      },
    ];
    const turns: TurnEnvelope[] = [{
      turnId: foregroundTurn,
      tenantId: "default",
      sessionId: "s1",
      chatId: "u1:s1",
      origin: "user",
      status: "completed",
      startedAt: 1784052584728,
      endedAt: 1784052596404,
    }];

    expect(canProjectDeterministically(timeline, CAPS)).toBe(false);
    const projected = projectLegacyTimeline(timeline, turns);
    expect(projected.some((item) => item.kind === "execution")).toBe(false);
    expect(projected.some((item) => item.kind === "single" && item.item.type === "artifact")).toBe(true);
  });
});

describe("projectTimelineByTurn — determinism across ingestion paths", () => {
  // One fixed log: two turns, each with a tool then answer; second turn has a
  // pre-answer failure and an artifact.
  const fixedLog: TimelineItem[] = [
    userMsg("turn_1000", "first question", 1),
    toolEvent("turn_1000", "c1", 2, { phase: "start" }),
    toolEvent("turn_1000", "c1", 3, { phase: "end", status: "success" }),
    assistantMsg("turn_1000", "first answer", 4),
    userMsg("turn_2000", "second question", 1),
    toolEvent("turn_2000", "c2", 2, { phase: "end", status: "error", error: "boom" }),
    artifact("turn_2000", "art-1", 3),
    assistantMsg("turn_2000", "second answer", 4),
  ];

  const reference = renderShape(projectTimelineByTurn(fixedLog));

  it("produces the same render tree for reversed input (pagination/reconnect ordering)", () => {
    const reversed = [...fixedLog].reverse();
    expect(renderShape(projectTimelineByTurn(reversed))).toEqual(reference);
  });

  it("produces the same render tree for an interleaved/shuffled input (live append)", () => {
    const shuffled = [
      fixedLog[4], fixedLog[0], fixedLog[7], fixedLog[2],
      fixedLog[5], fixedLog[1], fixedLog[6], fixedLog[3],
    ];
    expect(renderShape(projectTimelineByTurn(shuffled))).toEqual(reference);
  });

  it("groups every event of a turn contiguously (one avatar per turn)", () => {
    const shape = projectTimelineByTurn(fixedLog);
    // Walk the render items: turn ids must appear in contiguous runs.
    const turnRun: string[] = [];
    for (const ri of shape) {
      const tid = ri.kind === "execution" ? ri.block.turnId : (ri.item.turnId ?? (ri.item.data as { turnId?: string }).turnId);
      if (turnRun[turnRun.length - 1] !== tid) turnRun.push(tid ?? "");
    }
    // Each turn id shows up exactly once as a run boundary — never re-entered.
    expect(turnRun).toEqual([...new Set(turnRun)]);
    expect(turnRun).toEqual(["turn_1000", "turn_2000"]);
  });

  it("orders opaque turn ids by authoritative envelope start time", () => {
    const log = [
      userMsg("turn-z", "second", 1),
      assistantMsg("turn-z", "second answer", 2),
      userMsg("turn-a", "first", 1),
      assistantMsg("turn-a", "first answer", 2),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn-z", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 2, startedAt: 200 },
      { turnId: "turn-a", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 2, startedAt: 100 },
    ];
    expect(renderShape(projectTimelineByTurn(log, turns))).toEqual([
      { kind: "single", type: "message", role: "user", id: "u-turn-a-1", content: "first" },
      { kind: "single", type: "message", role: "assistant", id: "a-turn-a-2", content: "first answer" },
      { kind: "single", type: "message", role: "user", id: "u-turn-z-1", content: "second" },
      { kind: "single", type: "message", role: "assistant", id: "a-turn-z-2", content: "second answer" },
    ]);
  });
});

describe("projectTimelineByTurn — chronology and no reordering", () => {
  it("renders a pre-answer failure BEFORE the answer (no cosmetic move)", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "do it", 1),
      toolEvent("turn_1", "c1", 2, { phase: "end", status: "error", error: "denied" }),
      assistantMsg("turn_1", "here is the result", 3),
    ];
    const shape = renderShape(projectTimelineByTurn(log));
    const execIdx = shape.findIndex((s: any) => s.kind === "execution");
    const answerIdx = shape.findIndex((s: any) => s.kind === "single" && s.role === "assistant");
    expect(execIdx).toBeGreaterThanOrEqual(0);
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(execIdx).toBeLessThan(answerIdx);
  });

  it("keeps an artifact before the answer when it happened before the answer", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "make a report", 1),
      artifact("turn_1", "art-1", 2),
      assistantMsg("turn_1", "done", 3),
    ];
    const shape = renderShape(projectTimelineByTurn(log)) as any[];
    const artIdx = shape.findIndex((s) => s.type === "artifact");
    const answerIdx = shape.findIndex((s) => s.role === "assistant");
    expect(artIdx).toBeLessThan(answerIdx);
  });

  it("keeps the assistant stream/final inside the same turn as its tools", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
      toolEvent("turn_1", "c1", 3, { phase: "end" }),
      assistantMsg("turn_1", "streamed answer", 4, true),
    ];
    const items = projectTimelineByTurn(log);
    for (const ri of items) {
      const tid = ri.kind === "execution" ? ri.block.turnId : ri.item.turnId;
      expect(tid).toBe("turn_1");
    }
  });
});

describe("projectTimelineByTurn — no duplicates", () => {
  it("keeps one successful tool visible before the answer on the authoritative path", () => {
    const log = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "end", status: "success" }),
      assistantMsg("turn_1", "done", 3),
    ];
    const items = projectTimelineByTurn(log);
    expect(items.map((item) => item.kind)).toEqual(["single", "execution", "single"]);
  });

  it("coalesces repeated frames of one tool call into a single block, not duplicate tools", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
      toolEvent("turn_1", "c1", 3, { phase: "end", status: "success" }),
    ];
    const items = projectTimelineByTurn(log);
    const execBlocks = items.filter((ri) => ri.kind === "execution");
    expect(execBlocks).toHaveLength(1);
    expect(execBlocks[0].kind === "execution" && execBlocks[0].block.toolCount).toBe(1);
  });

  it("does not merge tools from two different turns into one block", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1000", "q1", 1),
      toolEvent("turn_1000", "c1", 2, { phase: "end", status: "error", error: "x" }),
      userMsg("turn_2000", "q2", 1),
      toolEvent("turn_2000", "c2", 2, { phase: "end", status: "error", error: "y" }),
    ];
    const execBlocks = projectTimelineByTurn(log).filter((ri) => ri.kind === "execution");
    expect(execBlocks).toHaveLength(2);
    const turnIds = execBlocks.map((ri) => ri.kind === "execution" && ri.block.turnId);
    expect(turnIds).toEqual(["turn_1000", "turn_2000"]);
  });
});

describe("projectTimelineByTurn — server terminal state", () => {
  it("resolves an orphaned running block to success when the turn envelope completed", () => {
    // A tool that never received its 'end' frame => recomputed status 'running'.
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
      toolEvent("turn_1", "c1b", 3, { phase: "start" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 3, startedAt: 1 },
    ];
    const withoutEnvelope = projectTimelineByTurn(log).filter((ri) => ri.kind === "execution")[0];
    const withEnvelope = projectTimelineByTurn(log, turns).filter((ri) => ri.kind === "execution")[0];
    expect(withoutEnvelope.kind === "execution" && withoutEnvelope.block.status).toBe("running");
    expect(withEnvelope.kind === "execution" && withEnvelope.block.status).toBe("success");
  });

  it("resolves an orphaned running block to error when the turn envelope failed", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
      toolEvent("turn_1", "c1b", 3, { phase: "start" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "failed", seqHighWater: 3, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).filter((ri) => ri.kind === "execution")[0];
    expect(block.kind === "execution" && block.block.status).toBe("error");
  });

  it("resolves an orphaned running block to cancelled when the turn was user-cancelled (Issue #626)", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "cancelled", seqHighWater: 2, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).filter((ri) => ri.kind === "execution")[0];
    expect(block.kind === "execution" && block.block.status).toBe("cancelled");
  });

  it("resolves an orphaned running block to interrupted when the turn was crash-interrupted (Issue #626)", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "interrupted", seqHighWater: 2, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).filter((ri) => ri.kind === "execution")[0];
    expect(block.kind === "execution" && block.block.status).toBe("interrupted");
  });

  it("lets authoritative cancellation override an error-shaped aborted tool end", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "end", status: "error", error: "aborted" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "cancelled", seqHighWater: 2, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).find((ri) => ri.kind === "execution");
    expect(block?.kind === "execution" && block.block.status).toBe("cancelled");
  });

  it("does not relabel work that already succeeded when the turn is cancelled", () => {
    // The production case: a foreground turn whose DAG had already completed in
    // the background. Stopping it rendered 44 successful tool calls and a
    // delivered PDF as a wall of "Cancelled" — a stop cannot un-happen work.
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "end", status: "success" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "cancelled", seqHighWater: 2, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).find((ri) => ri.kind === "execution");
    expect(block?.kind === "execution" && block.block.status).toBe("success");
  });

  it("keeps a partially-successful block mixed rather than calling it cancelled", () => {
    // Both outcomes really happened; "Cancelled" would erase each of them.
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "end", status: "success" }),
      toolEvent("turn_1", "c2", 3, { phase: "end", status: "error", error: "boom" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "cancelled", seqHighWater: 3, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).find((ri) => ri.kind === "execution");
    expect(block?.kind === "execution" && block.block.status).toBe("mixed");
  });

  it("leaves a genuinely open block running while the turn is still awaiting approval (Issue #626)", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "q", 1),
      toolEvent("turn_1", "c1", 2, { phase: "start" }),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "awaiting_approval", seqHighWater: 2, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).filter((ri) => ri.kind === "execution")[0];
    expect(block.kind === "execution" && block.block.status).toBe("running");
  });

  it("renders a background-origin turn as its own group ordered by start time (Issue #626)", () => {
    // A foreground user turn, then a later background turn (e.g. a durable plan
    // completion) delivered on the same session. They must stay distinct, ordered
    // by startedAt, never merged.
    const log: TimelineItem[] = [
      userMsg("turn_fg", "do it", 1),
      assistantMsg("turn_fg", "on it", 2),
      assistantMsg("turn_bg", "plan finished", 1),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_fg", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 2, startedAt: 100 },
      { turnId: "turn_bg", sessionId: "s", chatId: "c", origin: "background", status: "completed", seqHighWater: 1, startedAt: 500 },
    ];
    const shape = renderShape(projectTimelineByTurn(log, turns));
    expect(shape).toEqual([
      { kind: "single", type: "message", role: "user", id: "u-turn_fg-1", content: "do it" },
      { kind: "single", type: "message", role: "assistant", id: "a-turn_fg-2", content: "on it" },
      { kind: "single", type: "message", role: "assistant", id: "a-turn_bg-1", content: "plan finished" },
    ]);
  });
});

describe("projectTimelineByTurn — authoritative locale carry (Issue #628)", () => {
  it("consumes the envelope's carried locale, not the message character scan", () => {
    // The user prompt text is English, but the server carried zh-CN on the
    // envelope (e.g. the turn's canonical language). The block must present in
    // zh-CN — proving the projection reads the carried locale, not the prompt.
    const log: TimelineItem[] = [
      userMsg("turn_1", "please search", 1),
      toolEvent("turn_1", "c1", 2),
      toolEvent("turn_1", "c2", 3),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 3, startedAt: 1, locale: "zh-CN" },
    ];
    const block = projectTimelineByTurn(log, turns).find((ri) => ri.kind === "execution");
    expect(block?.kind === "execution" && block.block.locale).toBe("zh-CN");
  });

  it("falls back to the message character scan only when the envelope carries no locale (legacy)", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "帮我查一下", 1),
      toolEvent("turn_1", "c1", 2),
      toolEvent("turn_1", "c2", 3),
    ];
    // Legacy envelope: no locale field (predates #628).
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 3, startedAt: 1 },
    ];
    const block = projectTimelineByTurn(log, turns).find((ri) => ri.kind === "execution");
    expect(block?.kind === "execution" && block.block.locale).toBe("zh-CN");
  });

  it("ignores an unrecognized carried locale and falls back to the scan", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "please search", 1),
      toolEvent("turn_1", "c1", 2),
      toolEvent("turn_1", "c2", 3),
    ];
    const turns: TurnEnvelope[] = [
      { turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 3, startedAt: 1, locale: "fr" },
    ];
    const block = projectTimelineByTurn(log, turns).find((ri) => ri.kind === "execution");
    // 'fr' is not a UI locale → coerced away → English prompt scanned → 'en'.
    expect(block?.kind === "execution" && block.block.locale).toBe("en");
  });
});

describe("projectTimelineByTurn — typed plan events (Issue #735)", () => {
  function planStarted(turnId: string, planId: string, seq: number): TimelineItem {
    return {
      type: "plan_started",
      timestamp: 1000 + seq,
      turnId,
      seq,
      data: {
        plan_id: planId,
        goal: "Produce the report",
        phases: [
          { taskId: "t-a", title: "Collect data", dependsOn: [] },
          { taskId: "t-b", title: "Write report", dependsOn: ["t-a"] },
        ],
        locale: "en",
        timestamp: 1000 + seq,
        turnId,
        seq,
      },
    };
  }

  function taskUpdate(turnId: string, taskId: string, seq: number): TimelineItem {
    return {
      type: "task_update",
      timestamp: 1000 + seq,
      turnId,
      seq,
      data: {
        id: `task_${taskId}`,
        task_id: taskId,
        turnId,
        seq,
        title: "Produce the report",
        status: "pending" as const,
        rawStatus: "dag_created",
        timestamp: 1000 + seq,
      },
    };
  }

  it("carries the typed plan on the turn's execution block, never as a standalone row", () => {
    const log: TimelineItem[] = [
      userMsg("turn_1", "make me a report", 1),
      taskUpdate("turn_1", "plan-1", 2),
      planStarted("turn_1", "plan-1", 3),
      toolEvent("turn_1", "c1", 4),
    ];
    const items = projectTimelineByTurn(log);
    const singles = items.filter((ri) => ri.kind === "single");
    expect(singles.every((ri) => ri.kind === "single" && ri.item.type !== "plan_started")).toBe(true);
    const block = items.find((ri) => ri.kind === "execution");
    expect(block?.kind === "execution" && block.block.plan?.plan_id).toBe("plan-1");
    expect(block?.kind === "execution" && block.block.plan?.phases).toHaveLength(2);
    expect(block?.kind === "execution" && block.block.plan?.phases[1].dependsOn).toEqual(["t-a"]);
  });

  it("keeps the legacy (frozen) projection from rendering plan_started standalone", () => {
    const legacyLog: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "report please", timestamp: 1 } },
      { ...planStarted("turn_x", "plan-x", 2), turnId: undefined, seq: undefined },
      { ...taskUpdate("turn_x", "plan-x", 3), turnId: undefined, seq: undefined },
    ];
    const items = projectLegacyTimeline(legacyLog);
    expect(items.every((ri) => ri.kind !== "single" || ri.item.type !== "plan_started")).toBe(true);
  });
});

describe("plan forwarding across handoff-split blocks", () => {
  it("attaches the turn's typed plan to later execution blocks of the same turn", () => {
    const plan = {
      plan_id: "p1",
      goal: "Bond report",
      phases: [{ taskId: "dag1", title: "Research", dependsOn: [] }],
      timestamp: 1,
    };
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t1", seq: 0 } },
      { type: "plan_started", timestamp: 2, turnId: "t1", seq: 1, data: { ...plan, turnId: "t1", seq: 1 } },
      { type: "task_update", timestamp: 3, turnId: "t1", seq: 2, data: { id: "h1", task_id: "dag-root", title: "Plan", status: "completed", rawStatus: "dag_created", timestamp: 3, turnId: "t1", seq: 2 } },
      { type: "message", timestamp: 4, data: { id: "a1", role: "assistant", content: "I broke this down into a plan.", timestamp: 4, turnId: "t1", seq: 3 } },
      { type: "tool_event", timestamp: 5, turnId: "t1", seq: 4, data: { id: "w1", callId: "w1", taskId: "dag1", turnId: "t1", seq: 4, tool: "web_search", phase: "start", intent: "CPI", timestamp: 5 } },
    ];
    const items = projectTimelineByTurn(timeline, [{ turnId: "t1", status: "active" } as TurnEnvelope]);
    const executions = items.filter((item): item is Extract<ChatRenderItem, { kind: "execution" }> => item.kind === "execution");
    const working = executions.find((item) => item.block.tools.length > 0);
    expect(working?.block.plan?.plan_id).toBe("p1");
  });
});

describe("deliverable positioning (artifacts after the process)", () => {
  it("moves a pre-opened artifact after the turn's execution block, before the answer", () => {
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, turnId: "t-ord", seq: 0, data: { id: "u1", role: "user", content: "draw", timestamp: 1, turnId: "t-ord", seq: 0 } },
      // create_artifact pre-opens the card BEFORE the tool events finish.
      { type: "artifact", timestamp: 2, turnId: "t-ord", seq: 1, data: { id: "viz", plugin_id: "sandpack_v1", title: "Chart", status: "completed", data: { content_type: "svg", code: "<svg xmlns='http://www.w3.org/2000/svg'/>" }, timestamp: 2, turnId: "t-ord", seq: 1 } },
      { type: "tool_event", timestamp: 3, turnId: "t-ord", seq: 2, data: { id: "t1", callId: "t1", turnId: "t-ord", seq: 2, tool: "create_artifact", phase: "end", status: "success", intent: "chart", elapsed_ms: 400, timestamp: 3 } },
      { type: "message", timestamp: 4, turnId: "t-ord", seq: 3, data: { id: "a1", role: "assistant", content: "画好了。", timestamp: 4, turnId: "t-ord", seq: 3 } },
    ];
    const items = projectTimelineByTurn(timeline, [{ turnId: "t-ord", status: "completed" }] as TurnEnvelope[]);
    const kinds = items.map((item) => (item.kind === "execution" ? "execution" : (item.item.type === "message" ? (item.item.data as { role?: string }).role : item.item.type)));
    expect(kinds).toEqual(["user", "execution", "artifact", "assistant"]);
  });
});
