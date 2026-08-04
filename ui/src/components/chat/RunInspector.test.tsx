import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionRunDetail } from "@/types";
import RunInspector from "./RunInspector";

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/hooks/useApi", () => ({ useApi: () => ({ get: api.get }) }));

const detail: SessionRunDetail = {
  sessionId: "session-1",
  runId: "turn-1",
  claimedTurnIds: ["turn-1"],
  turns: [{
    turnId: "turn-1", sessionId: "session-1", chatId: "chat-1", origin: "user", status: "completed",
    seqHighWater: 8, startedAt: 1, endedAt: 8,
    outcome: { version: 1, state: "succeeded", code: "run_succeeded", verification: "passed", recoveredAttemptCount: 1, issues: [] },
  }],
  timeline: [
    { type: "plan_started", timestamp: 1, turnId: "turn-1", data: { plan_id: "p1", goal: "Build report", timestamp: 1, phases: [
      { taskId: "a", title: "Read inputs", dependsOn: [] },
      { taskId: "b", title: "Analyze", dependsOn: ["a"] },
      { taskId: "c", title: "Validate", dependsOn: ["a"] },
      { taskId: "d", title: "Publish", dependsOn: ["b", "c"] },
    ] } },
    { type: "message", timestamp: 2, turnId: "turn-1", data: { id: "r1", role: "assistant", content: "", timestamp: 2, turnId: "turn-1", reasoning: { provider: "test", summary: "I compared the source structure before writing.", streaming: false, startedAt: 2, completedAt: 3, durationMs: 1 } } },
    { type: "tool_event", timestamp: 3, turnId: "turn-1", data: { id: "tool-1", callId: "call-1", tool: "file_read", phase: "start", intent: "Read buyer guide", timestamp: 3 } },
    { type: "tool_event", timestamp: 4, turnId: "turn-1", data: { id: "tool-1-end", callId: "call-1", tool: "file_read", phase: "end", status: "error", error: "ENOENT /private/file", elapsed_ms: 1, timestamp: 4 } },
    { type: "tool_event", timestamp: 5, turnId: "turn-1", data: { id: "tool-2", callId: "call-2", tool: "file_read", phase: "end", status: "success", intent: "Read with absolute path", elapsed_ms: 1, timestamp: 5 } },
    { type: "artifact", timestamp: 6, turnId: "turn-1", data: { id: "artifact-1", plugin_id: "document_v1", title: "Buyer's guide", status: "completed", data: { role: "primary", markdown: "# Guide" }, timestamp: 6 } },
  ],
};

describe("RunInspector", () => {
  beforeEach(() => {
    api.get.mockReset();
    api.get.mockResolvedValue({ data: detail, error: null });
  });

  it("keeps overview, DAG, reasoning summary, recovered trace, and outputs in distinct modules", async () => {
    const onOpenArtifact = vi.fn();
    renderWithLocale(
      <RunInspector
        sessionId="session-1"
        turnId="turn-1"
        width={720}
        fullscreen={false}
        docked
        onResize={vi.fn()}
        onFullscreenChange={vi.fn()}
        onClose={vi.fn()}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    expect(screen.queryByText("Handled internal attempts: 1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getByTestId("run-plan-dag")).toBeInTheDocument();
    expect(screen.getAllByText("Publish").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Reasoning" }));
    expect(screen.getByText("I compared the source structure before writing.")).toBeInTheDocument();
    expect(screen.queryByText("secret raw reasoning")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.queryByText("Handled")).not.toBeInTheDocument();
    expect(screen.queryByText("File not found")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/file")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Outputs" }));
    fireEvent.click(screen.getByTestId("artifact-card"));
    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({ id: "artifact-1" }));
  });

  it("does not turn unrelated attempt failures into anomalies when the terminal run fails", async () => {
    api.get.mockResolvedValue({
      data: {
        ...detail,
        turns: [{
          ...detail.turns[0],
          status: "failed",
          outcome: {
            version: 1,
            state: "failed",
            code: "verification_failed",
            verification: "failed",
            recoveredAttemptCount: 1,
            issues: [{
              id: "verification-1",
              impact: "blocking",
              source: "verification",
              code: "result_not_verified",
            }],
          },
        }],
      },
      error: null,
    });

    renderWithLocale(
      <RunInspector
        sessionId="session-1"
        turnId="turn-1"
        width={720}
        fullscreen={false}
        docked
        onResize={vi.fn()}
        onFullscreenChange={vi.fn()}
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.queryByText("Attempt failed")).not.toBeInTheDocument();
    expect(screen.queryByText("/private/file")).not.toBeInTheDocument();
  });

  it("never renders internal outcome issues or generic recovery actions", async () => {
    api.get.mockResolvedValue({
      data: {
        ...detail,
        turns: [{
          ...detail.turns[0],
          status: "failed",
          outcome: {
            version: 1,
            state: "failed",
            code: "runtime_failed",
            verification: "incomplete",
            recoveredAttemptCount: 0,
            issues: [{ id: "runtime-failed", impact: "blocking", source: "runtime", code: "runtime_failed", action: "retry" }],
          },
        }],
        timeline: [
          { type: "message", timestamp: 0, turnId: "turn-1", data: { id: "request-1", role: "user", content: "Build the report", timestamp: 0, turnId: "turn-1" } },
          ...detail.timeline,
        ],
      },
      error: null,
    });

    renderWithLocale(
      <RunInspector sessionId="session-1" turnId="turn-1" width={720} fullscreen={false} docked onResize={vi.fn()} onFullscreenChange={vi.fn()} onClose={vi.fn()} onOpenArtifact={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    expect(screen.queryByText(/Unresolved impact|Verification found|Retry run/)).not.toBeInTheDocument();
    expect(screen.queryByTestId(/run-issue-action/)).not.toBeInTheDocument();
  });

  it("renders a failed terminal trace without guessing unidentified task failures", async () => {
    api.get.mockResolvedValue({
      data: {
        ...detail,
        turns: [{
          ...detail.turns[0],
          status: "failed",
          outcome: {
            version: 1,
            state: "failed",
            code: "task_failed",
            verification: "failed",
            recoveredAttemptCount: 0,
            issues: [{ id: "task-unknown", impact: "blocking", source: "task", code: "task_failed" }],
          },
        }],
        timeline: [
          ...detail.timeline,
          { type: "task_update", timestamp: 7, turnId: "turn-1", data: { id: "failed-history", task_id: "unknown", title: "Internal failed attempt", status: "failed", detail: "private retry detail", timestamp: 7, turnId: "turn-1" } },
        ],
      },
      error: null,
    });

    renderWithLocale(
      <RunInspector
        sessionId="session-1"
        turnId="turn-1"
        width={720}
        fullscreen={false}
        docked
        onResize={vi.fn()}
        onFullscreenChange={vi.fn()}
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.queryByText("Internal failed attempt")).not.toBeInTheDocument();
    expect(screen.getByText("Run ended").closest("article")).toHaveTextContent("Ended");
    expect(screen.getByText("Run ended").closest("article")).not.toHaveTextContent("Still affects the result");
  });

  it.each(["blocked", "cancelled", "interrupted", "degraded"] as const)("keeps the %s terminal outcome private in Trace", async (state) => {
    api.get.mockResolvedValue({
      data: {
        ...detail,
        turns: [{
          ...detail.turns[0],
          status: state === "cancelled" ? "cancelled" : state === "interrupted" ? "interrupted" : state === "blocked" ? "failed" : "completed",
          outcome: { version: 1, state, code: `run_${state}`, verification: "incomplete", recoveredAttemptCount: 0, issues: [] },
        }],
      },
      error: null,
    });
    renderWithLocale(
      <RunInspector sessionId="session-1" turnId="turn-1" width={720} fullscreen={false} docked onResize={vi.fn()} onFullscreenChange={vi.fn()} onClose={vi.fn()} onOpenArtifact={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByText("Run ended").closest("article")).toHaveTextContent("Ended");
  });

  it("does not invent a terminal Trace state for a legacy run without an outcome", async () => {
    api.get.mockResolvedValue({ data: { ...detail, turns: [{ ...detail.turns[0], outcome: undefined }] }, error: null });
    renderWithLocale(
      <RunInspector sessionId="session-1" turnId="turn-1" width={720} fullscreen={false} docked onResize={vi.fn()} onFullscreenChange={vi.fn()} onClose={vi.fn()} onOpenArtifact={vi.fn()} />,
    );
    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.queryByText("Run ended")).not.toBeInTheDocument();
  });

  it("keeps the logical run live while its background turn is active and follows realtime task updates", async () => {
    const baseProps = {
      sessionId: "session-1",
      turnId: "turn-1",
      width: 720,
      fullscreen: false,
      docked: true,
      onResize: vi.fn(),
      onFullscreenChange: vi.fn(),
      onClose: vi.fn(),
      onOpenArtifact: vi.fn(),
    };
    const background = {
      turnId: "turn_bg_p1", sessionId: "session-1", chatId: "chat-1", origin: "background" as const,
      status: "active" as const, seqHighWater: 1, startedAt: 2,
    };
    const liveTask = {
      type: "task_update" as const, timestamp: 9, turnId: "turn_bg_p1", seq: 1,
      data: { id: "live-a", task_id: "a", title: "Read inputs", status: "running" as const, timestamp: 9, turnId: "turn_bg_p1", seq: 1 },
    };
    const { rerender } = renderWithLocale(
      <RunInspector {...baseProps} liveTurns={[detail.turns[0], background]} liveTimeline={[liveTask]} />,
    );

    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
    expect(screen.queryByText("Completed")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);

    const finishedBackground = {
      ...background,
      status: "completed" as const,
      endedAt: 12,
      outcome: { version: 1 as const, state: "succeeded" as const, code: "run_succeeded", verification: "passed" as const, recoveredAttemptCount: 0, issues: [] },
    };
    const finishedTask = { ...liveTask, timestamp: 11, seq: 2, data: { ...liveTask.data, id: "live-a-done", status: "completed" as const, timestamp: 11, seq: 2 } };
    rerender(<RunInspector {...baseProps} liveTurns={[detail.turns[0], finishedBackground]} liveTimeline={[finishedTask]} />);
    fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
    await waitFor(() => expect(screen.getByTestId("run-tab-overview")).toBeInTheDocument());
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
  });

  it("uses nested turn identity for live events and keeps every tab on one deduplicated projection", async () => {
    const snapshot: SessionRunDetail = {
      ...detail,
      timeline: [
        ...detail.timeline,
        {
          type: "message", timestamp: 10, turnId: "turn-1", seq: 9,
          data: {
            id: "private-pass", role: "assistant", content: "", timestamp: 10, turnId: "turn-1", seq: 9,
            reasoning: { provider: "deepseek", hasPrivateReasoning: true, streaming: false, startedAt: 9, completedAt: 10, durationMs: 1 },
          },
        },
        {
          type: "artifact", timestamp: 11, turnId: "turn-1", seq: 10,
          data: { id: "workspace-note", plugin_id: "document_v1", title: "Internal working note", status: "completed", data: { role: "workspace", markdown: "private work" }, timestamp: 11, turnId: "turn-1", seq: 10 },
        },
      ],
    };
    api.get.mockResolvedValue({ data: snapshot, error: null });
    const duplicatePrivatePass = {
      type: "message" as const, timestamp: 10,
      data: {
        id: "private-pass", role: "assistant" as const, content: "", timestamp: 10, turnId: "turn-1",
        reasoning: { provider: "deepseek", hasPrivateReasoning: true, streaming: false, startedAt: 9, completedAt: 10, durationMs: 1 },
      },
    };
    const nestedTurnTask = {
      type: "task_update" as const, timestamp: 12,
      data: { id: "nested-a", task_id: "a", title: "Read inputs", status: "running" as const, timestamp: 12, turnId: "turn-1", seq: 11 },
    };

    renderWithLocale(
      <RunInspector
        sessionId="session-1"
        turnId="turn-1"
        liveTimeline={[duplicatePrivatePass, nestedTurnTask]}
        liveTurns={[{ ...detail.turns[0], status: "active", endedAt: undefined, outcome: undefined }]}
        width={720}
        fullscreen={false}
        docked
        onResize={vi.fn()}
        onFullscreenChange={vi.fn()}
        onClose={vi.fn()}
        onOpenArtifact={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByText("Running")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "Plan" }));
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("tab", { name: "Reasoning" }));
    expect(screen.getAllByText(/Reasoning pass/)).toHaveLength(2);
    expect(screen.getByText("This model did not provide a reasoning summary that can be displayed safely.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Outputs" }));
    expect(screen.getByText("Buyer's guide")).toBeInTheDocument();
    expect(screen.getByText("Internal working note")).toBeInTheDocument();
  });
});
