import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@/types";
import { useChat } from "./useChat";

describe("useChat streaming lifecycle", () => {
  it("adds one session-scoped memory notice and replaces a replay for the same turn", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({
        type: "memory_update", sessionId: "s2", turnId: "turn-1", count: 1,
        added: 1, reinforced: 0, updated: 0, factIds: [1], timestamp: 10,
      });
      result.current.handleWSMessage({
        type: "memory_update", sessionId: "s1", turnId: "turn-1", seq: 3, count: 1,
        added: 1, reinforced: 0, updated: 0, factIds: [41], timestamp: 11,
      });
      result.current.handleWSMessage({
        type: "memory_update", sessionId: "s1", turnId: "turn-1", seq: 3, count: 1,
        added: 0, reinforced: 1, updated: 0, factIds: [41], timestamp: 12,
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "memory_update", turnId: "turn-1", seq: 3,
      data: { count: 1, added: 0, reinforced: 1, updated: 0, factIds: [41] },
    });
  });

  it("restores only the active session compression lifecycle", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({ type: "context_compression", sessionId: "s2", stage: "summarizing", sourceTokens: 700, contextWindow: 1000 });
    });
    expect(result.current.contextCompression).toBeNull();
    act(() => {
      result.current.handleWSMessage({ type: "context_compression", sessionId: "s1", stage: "saving", sourceTokens: 700, contextWindow: 1000 });
    });
    expect(result.current.contextCompression).toMatchObject({ sessionId: "s1", stage: "saving", sourceTokens: 700 });
  });
  it("preserves the previous turn and appends a fresh regenerate turn", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.addMessage("user", "Book the hotel");
      result.current.handleWSMessage({ type: "message", role: "assistant", content: "Request failed: invalid api key", sessionId: "s1" });
      result.current.prepareRegenerate("Book the hotel");
      result.current.handleWSMessage({ type: "message", role: "assistant", content: "Request failed: quota", regenerate: true, turnId: "turn_retry", sessionId: "s1" });
    });

    expect(result.current.timeline.map((item) => (item.data as any).content)).toEqual([
      "Book the hotel",
      "Request failed: invalid api key",
      "Book the hotel",
      "Request failed: quota",
    ]);
    expect(result.current.sessionState).toBe("IDLE");
  });

  it("keeps the old turn and adds a new prompt before regenerate streaming", () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      result.current.addMessage("user", "Book the hotel");
      result.current.handleWSMessage({ type: "message", role: "assistant", content: "Request failed: invalid api key" });
      result.current.prepareRegenerate("Book the hotel");
    });

    expect(result.current.timeline.map((item) => (item.data as any).content)).toEqual([
      "Book the hotel",
      "Request failed: invalid api key",
      "Book the hotel",
    ]);
    expect(result.current.sessionState).toBe("WORKING");
  });

  it("compacts duplicate retry prompts from persisted timelines", () => {
    const { result } = renderHook(() => useChat());
    act(() => {
      result.current.loadTimeline([
        { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "Book the hotel", timestamp: 1 } },
        { type: "message", timestamp: 2, data: { id: "a1", role: "assistant", content: "Request failed: invalid api key", timestamp: 2 } },
        { type: "message", timestamp: 3, data: { id: "u2", role: "user", content: "Book the hotel", timestamp: 3 } },
        { type: "message", timestamp: 4, data: { id: "a2", role: "assistant", content: "Request failed: quota", timestamp: 4 } },
      ] as TimelineItem[]);
    });

    expect(result.current.timeline.map((item) => (item.data as any).content)).toEqual([
      "Book the hotel",
      "Request failed: quota",
    ]);
  });
  it("does not create timeline rows for empty stream placeholders", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({ type: "stream_start", requestId: "req-1" });
    });
    expect(result.current.timeline).toHaveLength(0);
    expect(result.current.sessionState).toBe("WORKING");

    act(() => {
      result.current.handleWSMessage({ type: "stream_end", requestId: "req-1", content: "" });
    });

    expect(result.current.timeline).toHaveLength(0);
    expect(result.current.sessionState).toBe("IDLE");
  });

  it("switches to responding only after visible answer text streams", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({ type: "stream_start", requestId: "req-visible" });
    });
    expect(result.current.sessionState).toBe("WORKING");

    act(() => {
      result.current.handleWSMessage({
        type: "stream_chunk",
        requestId: "req-visible",
        content: "Partial answer",
      });
    });

    expect(result.current.sessionState).toBe("RESPONDING");
    expect(result.current.timeline[0]).toMatchObject({
      type: "message",
      data: { role: "assistant", content: "Partial answer", streaming: true },
    });
  });

  it("keeps the assistant message when the stream ends with visible text", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({ type: "stream_start", requestId: "req-2" });
      result.current.handleWSMessage({ type: "stream_end", requestId: "req-2", content: "Final answer" });
    });

    expect(result.current.timeline).toHaveLength(1);
    const message = result.current.timeline[0];
    expect(message?.type).toBe("message");
    expect(message?.data).toMatchObject({ content: "Final answer", streaming: false });
  });

  it("keeps visible preface text when a tool-call stream ends empty", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({ type: "stream_start", requestId: "req-preface" });
      result.current.handleWSMessage({
        type: "stream_chunk",
        requestId: "req-preface",
        content: "I’ll check the data first.",
      });
      result.current.handleWSMessage({ type: "stream_end", requestId: "req-preface", content: "" });
    });

    expect(result.current.timeline).toHaveLength(1);
    const message = result.current.timeline[0];
    expect(message?.type).toBe("message");
    expect(message?.data).toMatchObject({
      content: "I’ll check the data first.",
      streaming: false,
    });
  });

  it("maps task_progress messages into task updates with user-facing status", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "task_progress",
        task_id: "task-1",
        jobId: "job-1",
        turnId: "turn-1",
        status: "pending",
        userStatus: "checking",
        title: "Checking task readiness",
        rawStatus: "queued",
        runtimeLabel: "Codex",
        timestamp: 100,
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "task_update",
      timestamp: 100,
      data: {
        task_id: "task-1",
        jobId: "job-1",
        turnId: "turn-1",
        status: "pending",
        userStatus: "checking",
        title: "Checking task readiness",
        rawStatus: "queued",
        runtimeLabel: "Codex",
      },
    });
  });

  it("drops session-scoped websocket messages for inactive sessions", () => {
    const { result } = renderHook(() => useChat("active-session"));

    const staleMessages = [
      { type: "message", role: "assistant", content: "stale answer", sessionId: "other-session" },
      { type: "stream_start", requestId: "req-stale", sessionId: "other-session" },
      { type: "stream_chunk", requestId: "req-stale", content: "stale stream", sessionId: "other-session" },
      { type: "stream_end", requestId: "req-stale", content: "stale final", sessionId: "other-session" },
      {
        type: "tool_event", phase: "start", tool: "web_search", status: "running",
        callId: "call-stale", sessionId: "other-session",
      },
      {
        type: "task_progress", task_id: "task-stale", status: "running",
        userStatus: "working", title: "Working", sessionId: "other-session",
      },
      { type: "approval_request", id: "approval-stale", description: "Approve stale action", sessionId: "other-session" },
      {
        type: "artifact_open",
        sessionId: "other-session",
        artifact: {
          id: "artifact-stale",
          title: "Stale artifact",
          status: "running",
          data: {},
        },
      },
      { type: "artifact_patch", artifactId: "artifact-stale", patch: { status: "completed" }, sessionId: "other-session" },
      { type: "artifact_close", artifactId: "artifact-stale", sessionId: "other-session" },
      { type: "active_turn", turnId: "turn-stale", sessionId: "other-session" },
    ];

    act(() => {
      for (const message of staleMessages) {
        expect(result.current.handleWSMessage(message)).toBe(false);
      }
    });

    expect(result.current.timeline).toHaveLength(0);
    expect(result.current.sessionState).toBe("IDLE");
    expect(result.current.activeTurnId).toBeNull();
  });

  it("accepts the first scoped stream immediately after adopting a server-bound session", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.adoptResolvedSession("session-new");
      expect(result.current.handleWSMessage({
        type: "stream_start",
        requestId: "req-new",
        sessionId: "session-new",
        turnId: "turn-new",
        seq: 2,
      })).toBe(true);
      expect(result.current.handleWSMessage({
        type: "stream_end",
        requestId: "req-new",
        sessionId: "session-new",
        turnId: "turn-new",
        seq: 2,
        content: "Bound answer",
      })).toBe(true);
      expect(result.current.handleWSMessage({
        type: "message",
        role: "assistant",
        sessionId: "other-session",
        content: "Wrong tab",
      })).toBe(false);
    });

    expect(result.current.timeline).toHaveLength(1);
    expect((result.current.timeline[0].data as { content?: string }).content).toBe("Bound answer");
    expect(result.current.sessionState).toBe("IDLE");
  });

  it("keeps session updates fail-open for sidebar state", () => {
    const { result } = renderHook(() => useChat("active-session"));

    act(() => {
      expect(result.current.handleWSMessage({
        type: "session_update",
        sessionId: "other-session",
        title: "Other session",
      })).toBe(true);
    });

    expect(result.current.timeline).toHaveLength(0);
  });

  it("does not render unscoped runtime command responses as assistant messages", () => {
    const { result } = renderHook(() => useChat("active-session"));

    act(() => {
      expect(result.current.handleWSMessage({
        type: "message",
        role: "assistant",
        content: "Runtime Status\nUptime: 4s\nTools: shell_exec",
      })).toBe(false);
    });

    expect(result.current.timeline).toHaveLength(0);
    expect(result.current.sessionState).toBe("IDLE");
  });

  it("uses turn lifecycle markers for session state only — never as timeline steps", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "task_progress",
        task_id: "turn-1:working",
        turnId: "turn-1",
        status: "running",
        userStatus: "working",
        title: "Working on task",
        rawStatus: "EXECUTING",
        timestamp: 120,
      });
    });

    // The marker keeps the chat visibly working (input lock / thinking dots)...
    expect(result.current.sessionState).toBe("WORKING");
    // ...but fabricated narrative steps must not render in the timeline.
    expect(result.current.timeline).toHaveLength(0);
  });

  it("keeps responding lifecycle markers in the pre-answer working phase", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "task_progress",
        task_id: "turn-1:responding",
        turnId: "turn-1",
        status: "running",
        userStatus: "responding",
        title: "Preparing response",
        rawStatus: "RUNNING",
        timestamp: 140,
      });
    });

    expect(result.current.sessionState).toBe("WORKING");
    expect(result.current.timeline).toHaveLength(0);
  });

  it("unlocks the session when the turn terminal marker arrives", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "task_progress",
        task_id: "turn-1:responding",
        turnId: "turn-1",
        status: "completed",
        userStatus: "responding",
        title: "Turn complete",
        rawStatus: "DONE",
        timestamp: 200,
      });
    });

    expect(result.current.sessionState).toBe("IDLE");
    expect(result.current.timeline).toHaveLength(0);
  });

  it("re-arms the working state when the runtime reports a live turn on connect", () => {
    const { result } = renderHook(() => useChat("s1"));

    act(() => {
      result.current.handleWSMessage({ type: "active_turn", turnId: "turn-live", sessionId: "s1" });
    });

    expect(result.current.sessionState).toBe("WORKING");
    expect(result.current.activeTurnId).toBe("turn-live");
  });

  it("upserts the authoritative locale from a live turn envelope without waiting for restore", () => {
    const { result } = renderHook(() => useChat("s1"));

    act(() => {
      result.current.handleWSMessage({
        type: "turn_envelope",
        turn: {
          turnId: "turn-live", sessionId: "s1", chatId: "c1", origin: "user",
          status: "active", seqHighWater: 0, startedAt: 1, locale: "zh-CN",
        },
      });
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ turnId: "turn-live", locale: "zh-CN", status: "active" }),
    ]);
  });

  it("ignores a live turn envelope from another session", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({
        type: "turn_envelope",
        turn: {
          turnId: "foreign", sessionId: "s2", chatId: "c2", origin: "user",
          status: "active", seqHighWater: 0, startedAt: 1, locale: "en",
        },
      });
    });
    expect(result.current.turns).toEqual([]);
  });

  it("mirrors live approval wait and resolution onto the turn envelope", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.loadTurns([{
        turnId: "turn-live", sessionId: "s1", chatId: "c1", origin: "user",
        status: "active", seqHighWater: 1, startedAt: 1, locale: "en",
      }]);
      result.current.handleWSMessage({
        type: "approval_request", id: "approval-1", description: "Approve?",
        sessionId: "s1", turnId: "turn-live",
      });
    });
    expect(result.current.turns[0]?.status).toBe("awaiting_approval");

    act(() => {
      result.current.handleWSMessage({
        type: "approval_resolved", id: "approval-1", status: "approved",
        sessionId: "s1", turnId: "turn-live",
      });
    });
    expect(result.current.turns[0]?.status).toBe("active");
  });

  it("stays idle when the runtime reports no active turn", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({ type: "active_turn", turnId: null });
    });

    expect(result.current.sessionState).toBe("IDLE");
    expect(result.current.activeTurnId).toBeNull();
  });

  it("drives the live activity from tool_composing without touching the timeline", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "tool_composing", phase: "start", tool: "file_write",
        callId: "c-compose", turnId: "turn-1", timestamp: 100,
      });
    });
    expect(result.current.sessionState).toBe("WORKING");
    expect(result.current.activeTool).toBe("file_write");
    expect(result.current.timeline).toHaveLength(0);

    act(() => {
      result.current.handleWSMessage({
        type: "tool_composing", phase: "end",
        callId: "c-compose", turnId: "turn-1", timestamp: 200,
      });
    });
    expect(result.current.activeTool).toBeNull();
    expect(result.current.timeline).toHaveLength(0);
  });

  it("unsticks a stale working state when the runtime reports no active turn", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      // Turn was running, then the server restarted mid-flight — the client
      // reconnects still believing it is WORKING with the input locked.
      result.current.handleWSMessage({
        type: "tool_event", tool: "web_search", phase: "start", status: "running",
        callId: "c1", turnId: "turn-dead", timestamp: 100,
      });
      result.current.handleWSMessage({ type: "active_turn", turnId: null });
    });

    expect(result.current.sessionState).toBe("IDLE");
    expect(result.current.activeTurnId).toBeNull();
  });

  it("drops persisted lifecycle markers from older builds on timeline restore", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.loadTimeline([
        {
          type: "task_update",
          timestamp: 100,
          data: {
            id: "t1", task_id: "turn-1:planning", turnId: "turn-1",
            title: "Understanding request and planning", status: "completed",
            userStatus: "planning", timestamp: 100,
          } as any,
        },
        {
          type: "task_update",
          timestamp: 200,
          data: {
            id: "t2", task_id: "job-42", jobId: "job-42",
            title: "Real background job", status: "completed", timestamp: 200,
          } as any,
        },
      ]);
    });

    // Only the real job survives; the fabricated lifecycle step is gone.
    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "task_update",
      data: { task_id: "job-42" },
    });
  });

  it("updates existing task progress in place", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "task_progress",
        task_id: "task-1",
        status: "running",
        userStatus: "working",
        title: "Working on task",
        timestamp: 100,
      });
      result.current.handleWSMessage({
        type: "task_progress",
        task_id: "task-1",
        status: "completed",
        userStatus: "done",
        title: "Task done",
        timestamp: 200,
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "task_update",
      timestamp: 100,
      data: {
        task_id: "task-1",
        status: "completed",
        userStatus: "done",
        title: "Task done",
      },
    });
  });

  it("loads persisted timeline items without collapsing execution rows into messages", () => {
    const { result } = renderHook(() => useChat());
    const persisted: TimelineItem[] = [
      {
        type: "tool_event",
        timestamp: 200,
        data: {
          id: "tool-call-1",
          callId: "call-1",
          tool: "browser_extract",
          phase: "end",
          status: "success",
          timestamp: 260,
        },
      },
      {
        type: "message",
        timestamp: 100,
        data: {
          id: "msg-user",
          role: "user",
          content: "Research OpenClaw",
          timestamp: 100,
        },
      },
      {
        type: "task_update",
        timestamp: 150,
        data: {
          id: "task-task-1",
          task_id: "task-1",
          title: "Collect public information",
          status: "completed",
          userStatus: "done",
          timestamp: 240,
        },
      },
    ];

    act(() => {
      result.current.loadTimeline(persisted);
    });

    expect(result.current.timeline.map((item) => item.type)).toEqual([
      "message",
      "task_update",
      "tool_event",
    ]);
    expect(result.current.timeline[1]).toMatchObject({
      type: "task_update",
      data: { task_id: "task-1", status: "completed" },
    });
    expect(result.current.timeline[2]).toMatchObject({
      type: "tool_event",
      data: { callId: "call-1", phase: "end" },
    });
  });

  it("keeps the user-facing tool intent when a tool finish event omits it", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "tool_event",
        phase: "start",
        tool: "browser_extract",
        callId: "call-1",
        intent: "Collect public release notes",
        timestamp: 100,
      });
      result.current.handleWSMessage({
        type: "tool_event",
        phase: "end",
        tool: "browser_extract",
        callId: "call-1",
        status: "success",
        result: "done",
        timestamp: 200,
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "tool_event",
      data: {
        callId: "call-1",
        phase: "end",
        status: "success",
        intent: "Collect public release notes",
      },
    });
  });

  it("merges artifact patches into top-level status and nested data", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        artifact: {
          id: "artifact-1",
          plugin_id: "sandpack_v1",
          title: "Report",
          status: "running",
          fallback_text: "Generating preview...",
          data: { content_type: "html", code: "" },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_patch",
        artifactId: "artifact-1",
        patch: {
          status: "completed",
          data: { code: "<!DOCTYPE html><html><body>Done</body></html>" },
        },
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "artifact",
      data: {
        id: "artifact-1",
        status: "completed",
        fallback_text: "Generating preview...",
        data: {
          content_type: "html",
          code: "<!DOCTYPE html><html><body>Done</body></html>",
        },
      },
    });
  });

  it("moves an artifact to the turn that regenerated it, live", () => {
    // The server re-scopes the row to the regenerating turn. Ignoring turnId here
    // left the card under the turn that first produced it until a reload moved
    // it — the live view and the restored view disagreeing about the same card.
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        turnId: "turn-1",
        seq: 3,
        artifact: {
          id: "file-1",
          plugin_id: "file_v1",
          title: "report.pdf",
          status: "completed",
          data: { path: "/out/report.pdf", size: 10 },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_patch",
        artifactId: "file-1",
        turnId: "turn-2",
        seq: 1,
        patch: { data: { size: 99 } },
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    const artifact = result.current.timeline[0].data as { turnId?: string; seq?: number; data: { size: number } };
    expect(artifact.turnId).toBe("turn-2");
    expect(artifact.seq).toBe(1);
    expect(artifact.data.size).toBe(99);
  });

  it("moves a restored artifact whose item carries the old turn id", () => {
    // The projection reads `item.turnId ?? data.turnId`, and a restored row has
    // `item.turnId` set by the server. Setting only `data.turnId` left the card
    // pinned to its old turn for precisely the sessions that had been reloaded —
    // and the earlier test missed it by building state through artifact_open,
    // which never sets item.turnId.
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.loadTimeline([
        {
          type: "artifact",
          timestamp: 100,
          turnId: "turn-1",
          seq: 3,
          // The real restored shape: the server persists turn identity in the
          // `turn_id` column and never writes it into the payload, so `data`
          // carries no turnId. Putting one here (as an earlier version of this
          // test did) hides the bug entirely.
          data: {
            id: "file-restored",
            plugin_id: "file_v1",
            title: "report.pdf",
            status: "completed",
            data: { path: "/out/report.pdf", size: 10 },
          },
        } as never,
      ]);
      result.current.handleWSMessage({
        type: "artifact_patch",
        artifactId: "file-restored",
        turnId: "turn-2",
        seq: 1,
        patch: { data: { size: 99 } },
      });
    });

    const item = result.current.timeline[0];
    expect(item.turnId).toBe("turn-2");
    expect((item.data as { turnId?: string }).turnId).toBe("turn-2");
  });

  it("keeps an artifact in its own turn while that turn streams patches", () => {
    // A card must not jump while the turn that owns it is still updating it.
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        turnId: "turn-1",
        seq: 3,
        artifact: {
          id: "file-2",
          plugin_id: "file_v1",
          title: "live.md",
          status: "running",
          data: { progress: 10 },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_patch",
        artifactId: "file-2",
        turnId: "turn-1",
        patch: { data: { progress: 80 } },
      });
    });

    const artifact = result.current.timeline[0].data as { turnId?: string; seq?: number };
    expect(artifact.turnId).toBe("turn-1");
    expect(artifact.seq).toBe(3);
  });

  it("marks an active session artifact as closed when artifact_close arrives", () => {
    const { result } = renderHook(() => useChat("active-session"));

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        sessionId: "active-session",
        artifact: {
          id: "artifact-active",
          plugin_id: "sandpack_v1",
          title: "Active preview",
          status: "running",
          data: { content_type: "html", code: "" },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_close",
        artifactId: "artifact-active",
        sessionId: "active-session",
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "artifact",
      data: {
        id: "artifact-active",
        status: "closed",
      },
    });
  });

  it("applies top-level plugin_id artifact patches without leaking plugin_id into data", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        artifact: {
          id: "artifact-plugin",
          plugin_id: "live_work_v1",
          title: "Live work",
          status: "running",
          data: { content_type: "html", code: "" },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_patch",
        artifactId: "artifact-plugin",
        patch: {
          plugin_id: "sandpack_v1",
          status: "completed",
        },
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    const item = result.current.timeline[0];
    expect(item).toMatchObject({
      type: "artifact",
      data: {
        id: "artifact-plugin",
        plugin_id: "sandpack_v1",
        status: "completed",
        data: {
          content_type: "html",
          code: "",
        },
      },
    });
    expect((item?.data as { data?: Record<string, unknown> }).data).not.toHaveProperty("plugin_id");
  });

  it("uses artifact patch updated_at as the artifact timestamp", () => {
    const { result } = renderHook(() => useChat());
    const updatedAt = "2026-07-03T09:30:00.000Z";

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        artifact: {
          id: "artifact-updated",
          plugin_id: "sandpack_v1",
          title: "Updated preview",
          status: "running",
          data: { content_type: "html", code: "" },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_patch",
        artifactId: "artifact-updated",
        patch: {
          updated_at: updatedAt,
          status: "completed",
        },
      });
    });

    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0]).toMatchObject({
      type: "artifact",
      data: {
        id: "artifact-updated",
        status: "completed",
        timestamp: Date.parse(updatedAt),
      },
    });
  });

  it("keeps concurrent artifacts with the same title separate when ids differ", () => {
    const { result } = renderHook(() => useChat());

    act(() => {
      result.current.handleWSMessage({
        type: "artifact_open",
        artifact: {
          id: "artifact-1",
          plugin_id: "sandpack_v1",
          title: "Preview",
          status: "running",
          fallback_text: "Generating preview...",
          data: { content_type: "html", code: "one" },
        },
      });
      result.current.handleWSMessage({
        type: "artifact_open",
        artifact: {
          id: "artifact-2",
          plugin_id: "sandpack_v1",
          title: "Preview",
          status: "running",
          fallback_text: "Generating preview...",
          data: { content_type: "html", code: "two" },
        },
      });
    });

    const artifacts = result.current.timeline.filter((item) => item.type === "artifact");
    expect(artifacts).toHaveLength(2);
    expect(artifacts.map((item) => item.data.id)).toEqual(["artifact-1", "artifact-2"]);
  });
});

describe("useChat turn identity + sequence wiring (Issue #625)", () => {
  it("captures the server timeline capabilities from the welcome frame", () => {
    const { result } = renderHook(() => useChat("s1"));
    expect(result.current.timelineCapabilities).toEqual([]);
    act(() => {
      result.current.handleWSMessage({ type: "welcome", username: "u", model: "m", capabilities: ["timeline_v1", "streaming_v1"] });
    });
    expect(result.current.timelineCapabilities).toEqual(["timeline_v1", "streaming_v1"]);
  });

  it("preserves the server-assigned seq on a live tool event", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({
        type: "tool_event", phase: "start", tool: "web_search", callId: "c1",
        turnId: "turn_1", seq: 5, sessionId: "s1", timestamp: 100,
      });
    });
    expect((result.current.timeline[0].data as any).seq).toBe(5);
    expect((result.current.timeline[0].data as any).turnId).toBe("turn_1");
  });

  it("preserves seq on a task update and keeps it when a later frame omits it", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({
        type: "task_progress", task_id: "job-1", jobId: "job-1", status: "running",
        userStatus: "working", title: "Working", turnId: "turn_1", seq: 7, sessionId: "s1", timestamp: 100,
      });
      // A follow-up frame without seq/turnId must not erase the assigned identity.
      result.current.handleWSMessage({
        type: "task_progress", task_id: "job-1", jobId: "job-1", status: "completed",
        userStatus: "done", title: "Done", sessionId: "s1", timestamp: 200,
      });
    });
    expect(result.current.timeline).toHaveLength(1);
    expect((result.current.timeline[0].data as any).seq).toBe(7);
    expect((result.current.timeline[0].data as any).turnId).toBe("turn_1");
    expect(result.current.timeline[0].timestamp).toBe(100);
    expect((result.current.timeline[0].data as any).timestamp).toBe(100);
  });

  it("keeps a tool at its first-seen position when the end frame arrives", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({ type: "tool_event", phase: "start", tool: "shell_exec", callId: "c1", timestamp: 100 });
      result.current.handleWSMessage({ type: "tool_event", phase: "end", tool: "shell_exec", callId: "c1", status: "success", elapsed_ms: 20, timestamp: 250 });
    });
    expect(result.current.timeline).toHaveLength(1);
    expect(result.current.timeline[0].timestamp).toBe(100);
    expect((result.current.timeline[0].data as any).timestamp).toBe(100);
    expect((result.current.timeline[0].data as any).phase).toBe("end");
  });

  it("carries seq through the assistant stream into the final message", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({ type: "stream_start", requestId: "r1", turnId: "turn_1", seq: 3, sessionId: "s1" });
      result.current.handleWSMessage({ type: "stream_chunk", requestId: "r1", content: "partial", sessionId: "s1" });
      result.current.handleWSMessage({ type: "stream_end", requestId: "r1", content: "final", sessionId: "s1" });
    });
    expect(result.current.timeline).toHaveLength(1);
    expect((result.current.timeline[0].data as any).seq).toBe(3);
    expect((result.current.timeline[0].data as any).turnId).toBe("turn_1");
    expect((result.current.timeline[0].data as any).content).toBe("final");
  });

  it("backfills the optimistic user message turn id from the first identity frame", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.addMessage("user", "do the thing");
    });
    // The optimistic user row has no turn id yet.
    expect((result.current.timeline[0].data as any).turnId).toBeUndefined();
    act(() => {
      result.current.handleWSMessage({ type: "active_turn", turnId: "turn_9", sessionId: "s1" });
    });
    // The turn's identity is now stamped onto the prompt that started it.
    expect((result.current.timeline[0].data as any).turnId).toBe("turn_9");
  });

  it("only backfills the most recent unidentified user message once", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.addMessage("user", "first", undefined, "turn_1");
      result.current.addMessage("user", "second");
      result.current.handleWSMessage({
        type: "tool_event", phase: "start", tool: "web_search", callId: "c1",
        turnId: "turn_2", seq: 2, sessionId: "s1", timestamp: 100,
      });
    });
    // The already-identified first prompt is untouched; only the new one is stamped.
    expect((result.current.timeline[0].data as any).turnId).toBe("turn_1");
    expect((result.current.timeline[1].data as any).turnId).toBe("turn_2");
  });

  it("stores restored turn envelopes via loadTurns and clears them", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.loadTurns([
        { turnId: "turn_1", sessionId: "s1", chatId: "c", origin: "user", status: "completed", seqHighWater: 4, startedAt: 1 },
      ]);
    });
    expect(result.current.turns).toHaveLength(1);
    expect(result.current.turns[0].status).toBe("completed");
    act(() => {
      result.current.clearTimeline();
    });
    expect(result.current.turns).toHaveLength(0);
  });
});

describe("useChat nested task-timeline wiring (Issue #624)", () => {
  it("carries parentTaskId + rawStatus from task_update and task_progress", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({
        type: "task_update", task_id: "sub-a", parentTaskId: "root", rawStatus: "task_failed",
        title: "Build", status: "failed", turnId: "turn_1", sessionId: "s1",
      });
      result.current.handleWSMessage({
        type: "task_progress", task_id: "sub-b", parentTaskId: "root", jobId: "worker_job_b",
        status: "running", userStatus: "working", title: "Deploy", turnId: "turn_1", sessionId: "s1",
      });
    });
    const tasks = result.current.timeline.filter((i) => i.type === "task_update").map((i) => i.data as any);
    const byId = new Map(tasks.map((t) => [t.task_id, t]));
    expect(byId.get("sub-a").parentTaskId).toBe("root");
    expect(byId.get("sub-a").rawStatus).toBe("task_failed");
    expect(byId.get("sub-b").parentTaskId).toBe("root");
  });

  it("preserves the first-seen parentTaskId when a later frame omits it", () => {
    const { result } = renderHook(() => useChat("s1"));
    act(() => {
      result.current.handleWSMessage({
        type: "task_progress", task_id: "sub-a", parentTaskId: "root", jobId: "worker_job_a",
        status: "running", userStatus: "working", title: "Build", turnId: "turn_1", sessionId: "s1",
      });
      // A heartbeat that omits parentTaskId must not re-parent or merge the task.
      result.current.handleWSMessage({
        type: "task_progress", task_id: "sub-a", jobId: "worker_job_a", heartbeat: true,
        status: "running", userStatus: "working", title: "Build", turnId: "turn_1", sessionId: "s1",
      });
    });
    const tasks = result.current.timeline.filter((i) => i.type === "task_update");
    expect(tasks).toHaveLength(1); // one node, concurrent-safe: not duplicated
    expect((tasks[0].data as any).parentTaskId).toBe("root");
  });
});
