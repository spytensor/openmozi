import { act, fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineItem } from "@/types";
import App from "@/App";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  apiDel: vi.fn(),
  fetchSessions: vi.fn(),
  fetchMessages: vi.fn(),
  fetchTimeline: vi.fn(),
  fetchContextCheckpoint: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionWorkspaceContext: vi.fn(),
  wsSend: vi.fn(),
  wsOnMessage: { current: null as ((message: Record<string, unknown>) => void) | null },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    state: "ready",
    error: null,
    oauthProviders: [],
    completeOnboarding: vi.fn(),
    logout: vi.fn(),
  }),
}));

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
    sessions: [{ id: "session-approval", title: "Approval", message_count: 2 }],
    activeSessionId: "session-approval",
    setActiveSessionId: vi.fn(),
    loading: false,
    fetchSessions: mocks.fetchSessions,
    createSession: vi.fn(),
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
    handleWSMessage: vi.fn(),
    toggle: vi.fn(),
  }),
}));

vi.mock("@/hooks/useRuntimeWorkspace", () => ({
  useRuntimeWorkspace: () => ({
    snapshot: { roots: [] },
    logs: null,
    service: null,
    loading: false,
    serviceBusy: false,
    error: null,
    refresh: vi.fn(),
    setServiceEnabled: vi.fn(),
  }),
}));

const timeline: TimelineItem[] = [
  {
    type: "message",
    timestamp: 100,
    data: { id: "user-1", role: "user", content: "Research online", timestamp: 100 },
  },
  {
    type: "message",
    timestamp: 200,
    data: { id: "assistant-1", role: "assistant", content: "Need approval.", timestamp: 200 },
  },
];

describe("permission elevation approval resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchContextCheckpoint.mockResolvedValue(null);
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.apiGet.mockImplementation((url: string) => {
      if (url === "/api/sessions/session-approval/permission-level") {
        return Promise.resolve({ data: { sessionId: "session-approval", permission_level: "L1_READ_WRITE" }, error: null });
      }
      return Promise.resolve({ data: { skills: [] }, error: null });
    });
    mocks.apiPost.mockResolvedValue({ data: null, error: null });
    mocks.apiPatch.mockResolvedValue({ data: null, error: null });
    mocks.apiDel.mockResolvedValue({ data: null, error: null });
    mocks.fetchSessions.mockResolvedValue(undefined);
    mocks.fetchMessages.mockResolvedValue([]);
    mocks.fetchTimeline.mockResolvedValue({ timeline, turns: [] });
    mocks.wsOnMessage.current = null;
  });

  it("refreshes the permission chip without rerunning the original prompt after approved elevation", async () => {
    renderWithLocale(<App />, { locale: "en" });

    await screen.findByText("Need approval.");
    expect(await screen.findByTestId("permission-chip")).toHaveTextContent("Ask");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "approval_request",
        id: "approval-1",
        description: "This session needs permission elevation.",
        action: "permission_elevation",
        sessionId: "session-approval",
        current_level: "L1_READ_WRITE",
        required_level: "L3_FULL_ACCESS",
        denied_action: "network.request",
        tool: "web_search",
        originating_prompt: "Research online",
      });
      mocks.wsOnMessage.current?.({
        type: "approval_resolved",
        id: "approval-1",
        status: "approved",
        action: "permission_elevation",
        sessionId: "session-approval",
        permission_level: "L3_FULL_ACCESS",
        originating_prompt: "Research online",
      });
    });

    expect(mocks.wsSend).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "message",
      content: "Research online",
      sessionId: "session-approval",
    }));
    expect(screen.getAllByTestId("message-user")).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByTestId("permission-chip")).toHaveTextContent("Full access");
    });
  });

  it("optimistically resolves the approval card on approve click without sending a rerun", async () => {
    renderWithLocale(<App />, { locale: "en" });

    await screen.findByText("Need approval.");

    act(() => {
      mocks.wsOnMessage.current?.({
        type: "approval_request",
        id: "approval-click",
        description: "This session needs permission elevation.",
        action: "permission_elevation",
        sessionId: "session-approval",
        current_level: "L1_READ_WRITE",
        required_level: "L3_FULL_ACCESS",
        denied_action: "network.request",
        tool: "web_search",
        originating_prompt: "Research online",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    expect(screen.getByTestId("approval-resolved-line")).toHaveTextContent("Approved");
    expect(mocks.wsSend).toHaveBeenCalledWith({
      type: "approve",
      id: "approval-click",
      sessionId: "session-approval",
      scope: "once",
    });
    expect(mocks.wsSend).not.toHaveBeenCalledWith(expect.objectContaining({
      type: "message",
      content: "Research online",
    }));
  });
});
