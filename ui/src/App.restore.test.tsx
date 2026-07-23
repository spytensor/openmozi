import { act, fireEvent, screen, waitFor, within, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineItem } from "@/types";
import App from "./App";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDel: vi.fn(),
  fetchSessions: vi.fn(),
  refreshSessionList: vi.fn(),
  fetchMessages: vi.fn(),
  fetchTimeline: vi.fn(),
  fetchContextCheckpoint: vi.fn(),
  createSession: vi.fn(),
  setActiveSessionId: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionWorkspaceContext: vi.fn(),
  wsSend: vi.fn(),
  wsOnMessage: { current: null as ((message: Record<string, unknown>) => void) | null },
  workspaceMessage: vi.fn(),
  logout: vi.fn(),
  completeOnboarding: vi.fn(),
  activeSessionId: "session-restore",
  initialAuthState: "ready" as string,
  setAuthState: null as ((state: string) => void) | null,
}));

vi.mock("@/hooks/useAuth", async () => {
  const { useState } = await import("react");
  return {
    useAuth: () => {
      const [state, setState] = useState(mocks.initialAuthState);
      mocks.setAuthState = setState;
      return {
        state,
        error: null,
        oauthProviders: [],
        completeOnboarding: mocks.completeOnboarding,
        logout: mocks.logout,
      };
    },
  };
});

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    get: mocks.apiGet,
    post: mocks.apiPost,
    patch: mocks.apiPatch,
    del: mocks.apiDel,
  }),
}));

vi.mock("@/hooks/useSession", () => ({
  useSession: () => ({
    sessions: [
      {
        id: "session-restore",
        title: "Timeline restore",
        updated_at: "2026-07-01T10:00:00.000Z",
        message_count: 4,
        workspace_root_id: "project",
        workspace_context: {
          rootPath: "/Users/test/Mozi",
          rootKind: "project_root",
          label: "Runtime Source",
          gitBranch: "main",
        },
      },
      {
        id: "session-other",
        title: "Other session",
        updated_at: "2026-07-01T11:00:00.000Z",
        message_count: 1,
      },
    ],
    activeSessionId: mocks.activeSessionId,
    setActiveSessionId: mocks.setActiveSessionId,
    loading: false,
    fetchSessions: mocks.fetchSessions,
    refreshSessionList: mocks.refreshSessionList,
    createSession: mocks.createSession,
    deleteSession: vi.fn(),
    fetchMessages: mocks.fetchMessages,
    fetchTimeline: mocks.fetchTimeline,
    fetchContextCheckpoint: mocks.fetchContextCheckpoint,
    updateSessionTitle: mocks.updateSessionTitle,
    updateSessionWorkspaceContext: mocks.updateSessionWorkspaceContext,
  }),
}));

vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: (options: { onMessage: (message: Record<string, unknown>) => void }) => {
    mocks.wsOnMessage.current = options.onMessage;
    return {
    status: "connected",
    send: mocks.wsSend,
    disconnect: vi.fn(),
    connectionEpoch: 0,
    };
  },
}));

vi.mock("@/hooks/useWorkspace", () => ({
  useWorkspace: () => ({
    enabled: false,
    state: {
      dag: [],
      budget: { used: 0, total: 0, percentage: 0 },
      providers: [],
      agents: [],
      tools: [],
      alerts: [],
      sessionState: "IDLE",
    },
    handleWSMessage: mocks.workspaceMessage,
    toggle: vi.fn(),
  }),
}));

vi.mock("@/hooks/useRuntimeWorkspace", () => ({
  useRuntimeWorkspace: () => ({
    snapshot: {
      roots: [
        {
          id: "project",
          kind: "project_root",
          label: "Runtime Source",
          path: "/Users/test/Mozi",
          exists: true,
          git: { is_repo: true, branch: "main" },
        },
      ],
    },
    logs: null,
    service: null,
    loading: false,
    serviceBusy: false,
    error: null,
    refresh: vi.fn(),
    setServiceEnabled: vi.fn(),
  }),
}));

vi.mock("@/components/settings/SettingsView", () => ({
  default: ({ initialCategory }: { initialCategory?: string }) => (
    <div data-testid="settings-initial-category">{initialCategory}</div>
  ),
}));

const restoredTimeline: TimelineItem[] = [
  {
    type: "message",
    timestamp: 100,
    data: {
      id: "msg-user",
      role: "user",
      content: "Restore this visible session",
      timestamp: 100,
    },
  },
  {
    type: "task_update",
    timestamp: 200,
    data: {
      id: "task-restore",
      task_id: "turn-restore:received",
      turnId: "turn-restore",
      title: "Request received",
      status: "completed",
      userStatus: "received",
      timestamp: 200,
    },
  },
  {
    type: "tool_event",
    timestamp: 300,
    data: {
      id: "tool-restore",
      callId: "call-restore",
      turnId: "turn-restore",
      tool: "browser_extract",
      phase: "end",
      status: "success",
      intent: "Verify restored tool step",
      elapsed_ms: 300,
      timestamp: 300,
    },
  },
  {
    type: "message",
    timestamp: 400,
    data: {
      id: "msg-assistant",
      role: "assistant",
      turnId: "turn-restore",
      content: "Restored final answer",
      timestamp: 400,
    },
  },
];

describe("App session timeline restore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.activeSessionId = "session-restore";
    mocks.initialAuthState = "ready";
    mocks.setAuthState = null;
    window.localStorage.clear();
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.apiGet.mockImplementation((url: string) => {
      if (url === "/api/sessions/session-restore/permission-level") {
        return Promise.resolve({ data: { sessionId: "session-restore", permission_level: "L1_READ_WRITE" }, error: null });
      }
      return Promise.resolve({ data: { skills: [] }, error: null });
    });
    mocks.apiPost.mockResolvedValue({ data: null, error: null });
    mocks.apiPatch.mockResolvedValue({ data: null, error: null });
    mocks.apiDel.mockResolvedValue({ data: null, error: null });
    mocks.wsOnMessage.current = null;
    mocks.fetchSessions.mockResolvedValue(undefined);
    mocks.refreshSessionList.mockResolvedValue(undefined);
    mocks.fetchMessages.mockResolvedValue([
      { role: "assistant", content: "legacy messages should not render", timestamp: 1 },
    ]);
    mocks.fetchTimeline.mockResolvedValue({ timeline: restoredTimeline, turns: [] });
    mocks.fetchContextCheckpoint.mockResolvedValue(null);
  });

  it("refreshes the sidebar when the server announces a new session", async () => {
    renderWithLocale(<App />);
    await waitFor(() => expect(mocks.wsOnMessage.current).not.toBeNull());
    mocks.refreshSessionList.mockClear();

    act(() => mocks.wsOnMessage.current?.({ type: "session_list_changed", sessionId: "session-run" }));

    expect(mocks.refreshSessionList).toHaveBeenCalledTimes(1);
    expect(mocks.setActiveSessionId).not.toHaveBeenCalledWith("session-run");
  });

  it("defers timeline restore until auth is ready, then restores once", async () => {
    // Regression: activeSessionId is restored synchronously from storage, so
    // the restore effect used to fire before the silent cookie refresh finished
    // and hit a guaranteed 401 (shown as "history could not be restored").
    mocks.initialAuthState = "loading";
    renderWithLocale(<App />);

    await act(async () => {});
    expect(mocks.fetchTimeline).not.toHaveBeenCalled();
    expect(mocks.fetchContextCheckpoint).not.toHaveBeenCalled();

    act(() => mocks.setAuthState?.("ready"));

    await waitFor(() => {
      expect(mocks.fetchTimeline).toHaveBeenCalledWith("session-restore");
    });
    expect(mocks.fetchTimeline).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Restored final answer")).toBeInTheDocument();
  });

  it("loads the persisted timeline without resurrecting live or simple-success status UI", async () => {
    renderWithLocale(<App />);

    await waitFor(() => {
      expect(mocks.fetchTimeline).toHaveBeenCalledWith("session-restore");
    });

    expect(mocks.fetchMessages).not.toHaveBeenCalled();
    expect(await screen.findByText("Restore this visible session")).toBeInTheDocument();
    expect(await screen.findByText("Restored final answer")).toBeInTheDocument();
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execution-live-line")).not.toBeInTheDocument();
    expect(document.querySelector(".animate-spin")).toBeNull();
    expect(screen.queryByText(/Verify restored tool step/)).not.toBeInTheDocument();
    expect(screen.queryByText("legacy messages should not render")).not.toBeInTheDocument();
    // The active project remains selected for scope injection, but the chat
    // body does not duplicate sidebar state as a separate Connected banner.
    expect(screen.queryByTestId("project-context-bar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Projects/i })).not.toBeInTheDocument();
    expect(screen.queryByText("General task")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer-reading-rail")).toHaveClass("max-w-[960px]", "px-4");
  });

  it("renders no floating execution HUD — the chat owns the plan surface", async () => {
    renderWithLocale(<App />);
    await screen.findByText("Restored final answer");

    expect(screen.queryByTestId("execution-float-anchor")).toBeNull();
  });

  it("opens the existing Settings memory category from a live memory notice", async () => {
    renderWithLocale(<App />);
    await waitFor(() => expect(mocks.fetchTimeline).toHaveBeenCalledWith("session-restore"));

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "memory_update", sessionId: "session-restore", turnId: "turn-memory", seq: 5,
        count: 1, added: 1, reinforced: 0, updated: 0, factIds: [41], timestamp: 500,
      });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Saved to memory. Open memory" }));

    expect(await screen.findByTestId("settings-initial-category")).toHaveTextContent("memory");
  });

  it("restores a durable context compression stage for the active session", async () => {
    mocks.fetchContextCheckpoint.mockResolvedValue({
      sessionId: "session-restore",
      stage: "summarizing",
      sourceTokens: 700,
      contextWindow: 1000,
      timestamp: Date.now(),
    });
    renderWithLocale(<App />);
    expect(await screen.findByText("Organizing earlier context…")).toBeInTheDocument();
    expect(screen.getByTestId("context-compression-status")).toHaveTextContent("Context 70% used");
  });

  it("subscribes the WebSocket to the restored session", async () => {
    renderWithLocale(<App />);

    await waitFor(() => {
      expect(mocks.wsSend).toHaveBeenCalledWith({
        type: "select_session",
        sessionId: "session-restore",
      });
    });
  });

  it("clears the previous timeline immediately when switching sessions", async () => {
    const { rerender } = renderWithLocale(<App />);
    expect(await screen.findByText("Restored final answer")).toBeInTheDocument();

    type TimelinePayload = { timeline: TimelineItem[]; turns: never[] };
    let resolveOther: (value: TimelinePayload) => void = () => {};
    mocks.fetchTimeline.mockImplementation((sessionId: string) => (
      sessionId === "session-other"
        ? new Promise<TimelinePayload>((resolve) => { resolveOther = resolve; })
        : Promise.resolve({ timeline: restoredTimeline, turns: [] })
    ));
    mocks.activeSessionId = "session-other";
    rerender(<App />);

    await waitFor(() => expect(mocks.fetchTimeline).toHaveBeenCalledWith("session-other"));
    expect(screen.queryByText("Restored final answer")).not.toBeInTheDocument();

    act(() => resolveOther({ timeline: [], turns: [] }));
  });

  it("does not let chat messages override the server-owned execution scope", async () => {
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");
    const textarea = screen.getByPlaceholderText("Message MOZI...");
    fireEvent.change(textarea, { target: { value: "plain chat message" } });
    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledWith({
        type: "message",
        content: "plain chat message",
        sessionId: "session-restore",
      }));
    expect(await screen.findAllByTestId("message-user")).toHaveLength(2);
    expect(screen.getByText("plain chat message")).toBeInTheDocument();
  });

  it("preserves the prior turn and shows regenerate as a distinct retry turn", async () => {
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");

    expect(screen.getAllByTestId("message-user")).toHaveLength(1);
    fireEvent.click(within(screen.getByTestId("message-user")).getByRole("button", { name: "Regenerate" }));

    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: "message",
        content: "Restore this visible session",
        sessionId: "session-restore",
        regenerate: true,
      })));
    expect(screen.getAllByTestId("message-user")).toHaveLength(2);
  });

  it("refreshes permission after elevation approval ack without rerunning the prompt", async () => {
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");
    expect(await screen.findByTestId("permission-chip")).toHaveTextContent("Ask");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "approval_request",
        id: "approval-elevation",
        description: "This session needs permission elevation.",
        action: "permission_elevation",
        sessionId: "session-restore",
        current_level: "L1_READ_WRITE",
        required_level: "L3_FULL_ACCESS",
        denied_action: "network.request",
        tool: "web_search",
        originating_prompt: "Restore this visible session",
      });
      mocks.wsOnMessage.current?.({
        type: "approval_resolved",
        id: "approval-elevation",
        status: "approved",
        action: "permission_elevation",
        sessionId: "session-restore",
        permission_level: "L3_FULL_ACCESS",
        current_level: "L1_READ_WRITE",
        required_level: "L3_FULL_ACCESS",
        denied_action: "network.request",
        tool: "web_search",
        originating_prompt: "Restore this visible session",
      });
    });

    expect(mocks.wsSend).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "message",
      content: "Restore this visible session",
      sessionId: "session-restore",
    }));
    expect(screen.getAllByTestId("message-user")).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByTestId("permission-chip")).toHaveTextContent("Full access");
    });
  });

  it("does not auto-open a stale completed artifact when a later task starts", async () => {
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-switch:working",
        turnId: "turn-switch",
        title: "Working on task",
        status: "running",
        userStatus: "working",
      });
      mocks.wsOnMessage.current?.({
        type: "artifact_open",
        artifact: {
          id: "artifact-old",
          plugin_id: "sandpack_v1",
          title: "Old report",
          status: "completed",
          data: { content_type: "html", code: "<div class='chart'><h1>Old</h1></div>" },
        },
      });
    });

    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-new:working",
        turnId: "turn-new",
        title: "Working on task",
        status: "running",
        userStatus: "working",
      });
    });

    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
  });

  it("auto-opens a completed artifact when it belongs to the active turn", async () => {
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-current:working",
        turnId: "turn-current",
        title: "Working on task",
        status: "running",
        userStatus: "working",
      });
      mocks.wsOnMessage.current?.({
        type: "artifact_open",
        artifact: {
          id: "artifact-current",
          plugin_id: "workspace_hub_v1",
          title: "Current report",
          status: "completed",
          data: {
            content_type: "html",
            code: "<div class='chart'><h1>Current</h1></div>",
            meta: { turn_id: "turn-current" },
          },
        },
      });
    });

    // Artifacts never auto-open (operator contract 2026-07-18): the panel
    // stays closed until the user clicks the chat card.
    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Visualization actions" })[0]);
    fireEvent.click(screen.getByTestId("inline-visual-open-panel"));
    expect(await screen.findByTestId("artifact-panel")).toBeInTheDocument();
    expect(screen.getAllByText("Current report").length).toBeGreaterThan(0);
  });

  it("never auto-opens a live artifact and opens it on card click after completion", async () => {
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-live:working",
        turnId: "turn-live",
        title: "Working on task",
        status: "running",
        userStatus: "working",
      });
      mocks.wsOnMessage.current?.({
        type: "artifact_open",
        artifact: {
          id: "artifact-live",
          plugin_id: "sandpack_v1",
          title: "Live report",
          status: "running",
          fallback_text: "Generating report...",
          data: { content_type: "html", code: "" },
        },
      });
    });

    // No takeover while the turn works — the card is the only surface.
    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "artifact_patch",
        artifactId: "artifact-live",
        patch: {
          status: "completed",
          data: { code: "<div class='chart'><h1>Done</h1></div>" },
        },
      });
    });

    expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("inline-visual-card")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Visualization actions" })[0]);
    fireEvent.click(screen.getByTestId("inline-visual-open-panel"));

    expect(await screen.findByTestId("artifact-panel")).toBeInTheDocument();
    expect(screen.getAllByText("Live report").length).toBeGreaterThan(0);
  });

  it("attributes cancelled turns correctly: user stop vs runtime restart", async () => {
    renderWithLocale(<App />);
    await screen.findByText("Restored final answer");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-user:failed",
        turnId: "turn-user",
        title: "Request cancelled",
        status: "failed",
        userStatus: "blocked",
        rawStatus: "CANCELLED",
        detail: "User requested cancellation",
      });
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-restart:failed",
        turnId: "turn-restart",
        title: "Request cancelled",
        status: "failed",
        userStatus: "blocked",
        rawStatus: "CANCELLED",
        detail: "Runtime restarting",
      });
      // Superseded turns stay quiet — no transcript noise for a normal re-ask.
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-superseded:failed",
        turnId: "turn-superseded",
        title: "Request cancelled",
        status: "failed",
        userStatus: "blocked",
        rawStatus: "CANCELLED",
        detail: "Turn superseded by new message",
      });
    });

    expect(await screen.findByText("You stopped this response")).toBeInTheDocument();
    expect(screen.getByText("The runtime restarted — this task was interrupted")).toBeInTheDocument();
    expect(screen.queryByText(/superseded/i)).not.toBeInTheDocument();
  });

  it("clears the active artifact workspace when switching sessions", async () => {
    const view = renderWithLocale(<App />);

    await screen.findByText("Restored final answer");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "artifact_open",
        artifact: {
          id: "artifact-switch",
          plugin_id: "sandpack_v1",
          title: "Switch report",
          status: "completed",
          data: { content_type: "html", code: "<div class='chart'><h1>Switch</h1></div>" },
        },
      });
    });

    fireEvent.click((await screen.findAllByRole("button", { name: "Visualization actions" }))[0]);
    fireEvent.click(screen.getByTestId("inline-visual-open-panel"));
    expect(await screen.findByTestId("artifact-panel")).toBeInTheDocument();

    act(() => {
      mocks.activeSessionId = "session-other";
      view.rerender(<App />);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-panel")).not.toBeInTheDocument();
    });
  });

  it("keeps artifact drag and fullscreen state wired into the main layout", async () => {
    // Keep a usable chat column in JSDOM so the artifact uses its docked path.
    window.localStorage.setItem("mozi.ui.sidebarCollapsed", "1");
    window.localStorage.setItem("mozi.ui.artifactPanelWidth", "380");
    renderWithLocale(<App />);

    await screen.findByText("Restored final answer");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "task_progress",
        task_id: "turn-layout:working",
        turnId: "turn-layout",
        title: "Working on task",
        status: "running",
        userStatus: "working",
      });
      mocks.wsOnMessage.current?.({
        type: "artifact_open",
        artifact: {
          id: "artifact-layout",
          plugin_id: "sandpack_v1",
          title: "Layout report",
          status: "running",
          data: { content_type: "html", code: "" },
        },
      });
    });

    // Click-to-open (no auto-open contract), then exercise drag/fullscreen.
    fireEvent.click(screen.getByRole("button", { name: /Layout report/i }));
    const panel = await screen.findByTestId("artifact-panel");
    const shell = screen.getByTestId("chat-shell");
    expect(panel.style.width).toBe(shell.style.marginRight);

    await act(async () => {
      screen.getByTestId("artifact-resize-handle").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 800 }),
      );
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 720 }));
      await Promise.resolve();
    });

    act(() => {
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 720 }));
    });

    expect(panel.style.width).toBe(shell.style.marginRight);
    expect(Number.parseInt(panel.style.width, 10)).toBeGreaterThan(400);

    fireEvent.click(screen.getByRole("button", { name: "Fullscreen" }));

    expect(screen.getByTestId("artifact-panel")).toHaveClass("z-[100]");
    expect(shell.style.marginRight).toBe("0px");
  });
});
