import { describe, it, expect } from "vitest";
import type { TimelineItem, TurnEnvelope } from "@/types";
import { canProjectDeterministically, projectTimelineByTurn } from "./turn-projection";

/**
 * 500-turn performance budget (Issue #628 acceptance).
 * ----------------------------------------------------
 * The deterministic projection is the per-render hot path for the chat timeline;
 * ChatView memoizes it, but it still re-runs on every timeline mutation (each
 * streamed chunk) of a long session. This test pins a documented budget so a
 * future change that makes the projection super-linear fails CI instead of
 * silently regressing a 500-turn session.
 *
 * Budget: a 500-turn session (~7 events/turn ≈ 3,500 items) must project in
 * under PROJECTION_BUDGET_MS as a median over repeated runs on CI hardware. The
 * threshold is intentionally generous (the projection is O(n log n) and measures
 * well under it locally) so the test is not flaky — it guards against algorithmic
 * regressions, not microsecond noise.
 */
const TURNS = 500;
const PROJECTION_BUDGET_MS = 120;

function buildLongSession(): { timeline: TimelineItem[]; turns: TurnEnvelope[] } {
  const timeline: TimelineItem[] = [];
  const turns: TurnEnvelope[] = [];
  let seq = 0;
  for (let t = 0; t < TURNS; t++) {
    const turnId = `turn_${1000 + t}`;
    const startedAt = 1000 + t;
    const zh = t % 2 === 0;
    turns.push({
      turnId,
      sessionId: "s",
      chatId: "c",
      origin: "user",
      status: "completed",
      seqHighWater: 5,
      startedAt,
      locale: zh ? "zh-CN" : "en",
    });
    const stamp = (extra: Record<string, unknown>): TimelineItem["data"] =>
      ({ turnId, seq: ++seq, timestamp: startedAt, ...extra }) as TimelineItem["data"];
    timeline.push({ type: "message", timestamp: startedAt, turnId, seq, data: stamp({ id: `u-${t}`, role: "user", content: zh ? "帮我查一下" : "look this up" }) });
    for (let k = 0; k < 3; k++) {
      timeline.push({ type: "tool_event", timestamp: startedAt, turnId, seq, data: stamp({ id: `tool-${t}-${k}`, callId: `c-${t}-${k}`, tool: "web_search", phase: "end", status: "success", intent: "search", elapsed_ms: 900 }) });
    }
    timeline.push({ type: "message", timestamp: startedAt, turnId, seq, data: stamp({ id: `a-${t}`, role: "assistant", content: zh ? "完成了" : "done" }) });
  }
  return { timeline, turns };
}

describe("projectTimelineByTurn — 500-turn performance budget (Issue #628)", () => {
  const { timeline, turns } = buildLongSession();

  it("qualifies for the deterministic path", () => {
    expect(canProjectDeterministically(timeline, ["timeline_v1"])).toBe(true);
    expect(timeline.length).toBeGreaterThan(TURNS * 4);
  });

  it("projects a 500-turn session within the documented budget", () => {
    // Warm up (JIT + first-run allocation), then take a median over samples so a
    // single GC pause cannot fail the run.
    projectTimelineByTurn(timeline, turns);
    const samples: number[] = [];
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      const result = projectTimelineByTurn(timeline, turns);
      samples.push(performance.now() - start);
      expect(result.length).toBeGreaterThan(0);
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)];
    expect(median).toBeLessThan(PROJECTION_BUDGET_MS);
  });

  it("is deterministic — identical input yields a deep-equal projection (supports memoization)", () => {
    const a = projectTimelineByTurn(timeline, turns);
    const b = projectTimelineByTurn(timeline, turns);
    // Same input must produce structurally identical output; this is the property
    // ChatView's useMemo relies on to skip re-projection and re-render.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("carries per-turn locale across the whole session (EN/ZH interleaved)", () => {
    const blocks = projectTimelineByTurn(timeline, turns).filter((ri) => ri.kind === "execution");
    const locales = new Set(blocks.map((ri) => (ri.kind === "execution" ? ri.block.locale : undefined)));
    expect(locales.has("zh-CN")).toBe(true);
    expect(locales.has("en")).toBe(true);
    // No block should be missing a carried locale in a fully-enveloped session.
    expect(locales.has(undefined)).toBe(false);
  });
});
