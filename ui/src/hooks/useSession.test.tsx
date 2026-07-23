import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSession } from "./useSession";

const ACTIVE_SESSION_STORAGE_KEY = "mozi.ui.activeSessionId";

function session(id: string) {
  return {
    id,
    title: id,
    created_at: "2026-07-01T14:00:00.000Z",
    updated_at: "2026-07-01T14:00:00.000Z",
    message_count: 1,
  };
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("useSession", () => {
  it("restores a stored active session on boot when it is present in the fetched list", async () => {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, "session-b");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [session("session-a"), session("session-b")] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());

    await act(async () => {
      await result.current.fetchSessions();
    });

    expect(result.current.activeSessionId).toBe("session-b");
    expect(window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe("session-b");
    expect(window.location.hash).toBe("#/session/session-b");
  });

  it("falls back to the first fetched session when the stored active session is stale", async () => {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, "stale-session");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [session("session-a"), session("session-b")] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());

    await act(async () => {
      await result.current.fetchSessions();
    });

    expect(result.current.activeSessionId).toBe("session-a");
    expect(window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe("session-a");
    expect(window.location.hash).toBe("#/session/session-a");
  });

  it("loads every session page for the sidebar", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => session(`session-${index + 1}`));
    const secondPage = [session("session-101")];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: firstPage, total: 101 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: secondPage, total: 101 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());
    await act(async () => {
      await result.current.fetchSessions();
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions?limit=100&offset=0");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sessions?limit=100&offset=100");
    expect(result.current.sessions).toHaveLength(101);
    expect(result.current.sessions.at(-1)?.id).toBe("session-101");
  });

  it("applies live activity to an inactive session and clears it on terminal state", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [session("session-a"), session("session-b")], total: 2 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSession());
    await act(async () => { await result.current.fetchSessions(); });

    act(() => result.current.updateSessionActivity("session-b", "running", 1234));
    expect(result.current.sessions.find((item) => item.id === "session-b")).toMatchObject({
      activity_status: "running",
      activity_started_at: 1234,
    });

    act(() => result.current.updateSessionActivity("session-b", null));
    expect(result.current.sessions.find((item) => item.id === "session-b")).toMatchObject({
      activity_status: null,
      activity_started_at: null,
    });
  });

  it("adopts a server-bound session immediately and refreshes its sidebar row", async () => {
    const bound = { ...session("session-bound"), title: "Bound chat" };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [bound], total: 1 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());
    await act(async () => {
      await result.current.adoptSession(bound.id);
    });

    expect(result.current.activeSessionId).toBe(bound.id);
    expect(result.current.sessions).toEqual([bound]);
    expect(window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe(bound.id);
    expect(window.location.hash).toBe(`#/session/${bound.id}`);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions?limit=100&offset=0");
  });

  it("refreshes a newly announced session without changing the active chat", async () => {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, "session-current");
    const current = session("session-current");
    const run = session("session-run");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [current], total: 1 }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: [run, current], total: 2 }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());
    await act(async () => { await result.current.fetchSessions(); });
    await act(async () => { await result.current.refreshSessionList(); });

    expect(result.current.sessions.map((item) => item.id)).toEqual(["session-run", "session-current"]);
    expect(result.current.activeSessionId).toBe("session-current");
    expect(window.location.hash).toBe("#/session/session-current");
  });

  it("prefers the URL hash over local storage when restoring the active session", async () => {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, "session-a");
    window.history.replaceState(null, "", "/#/session/session-b");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessions: [session("session-a"), session("session-b")] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());

    await act(async () => {
      await result.current.fetchSessions();
    });

    expect(result.current.activeSessionId).toBe("session-b");
    expect(window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY)).toBe("session-b");
    expect(window.location.hash).toBe("#/session/session-b");
  });

  it("upserts reused draft sessions instead of duplicating rows", async () => {
    const draft = {
      id: "sess-11111111-1111-4111-8111-111111111111",
      title: "New Chat",
      created_at: "2026-07-01T14:00:00.000Z",
      updated_at: "2026-07-01T14:00:00.000Z",
      message_count: 0,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: draft, reused: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { ...draft, updated_at: "2026-07-01T14:00:05.000Z" }, reused: true }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());

    await act(async () => {
      await result.current.createSession();
      await result.current.createSession();
    });

    expect(result.current.sessions).toHaveLength(1);
    expect(result.current.sessions[0]).toMatchObject({
      id: draft.id,
      updated_at: "2026-07-01T14:00:05.000Z",
    });
    expect(result.current.activeSessionId).toBe(draft.id);
  });

  it("persists workspace context when creating and updating a session", async () => {
    const session = {
      id: "session-project",
      title: "New Chat",
      created_at: "2026-07-01T14:00:00.000Z",
      updated_at: "2026-07-01T14:00:00.000Z",
      message_count: 0,
      workspace_root_id: "project",
      workspace_context: {
        rootPath: "/Users/test/Mozi",
        rootKind: "project_root",
        label: "Runtime Source",
        gitBranch: "main",
      },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session, reused: false }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session: {
            ...session,
            workspace_root_id: null,
            workspace_context: null,
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());

    await act(async () => {
      await result.current.createSession({
        workspaceRootId: "project",
        workspaceContext: session.workspace_context,
      });
      await result.current.updateSessionWorkspaceContext("session-project", {
        workspaceRootId: null,
        workspaceContext: null,
      });
    });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/sessions");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      workspaceRootId: "project",
      workspaceContext: session.workspace_context,
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sessions/session-project");
    expect(fetchMock.mock.calls[1][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      workspaceRootId: null,
      workspaceContext: null,
    });
    expect(result.current.sessions[0].workspace_root_id).toBeNull();
  });

  it("fetches the persisted session timeline for exact chat restore", async () => {
    const timeline = [
      {
        type: "tool_event",
        timestamp: 100,
        data: { id: "tool-call-1", callId: "call-1", tool: "browser", phase: "end", status: "success", timestamp: 120 },
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: "session-1", timeline, nextCursor: "cursor-1", hasMore: true }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSession());

    let restored: { timeline: unknown[]; turns: unknown[] } = { timeline: [], turns: [] };
    await act(async () => {
      restored = await result.current.fetchTimeline("session-1");
    });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/sessions/session-1/timeline?limit=100");
    expect(options).toMatchObject({
      method: "GET",
      credentials: "include",
    });
    expect(restored.timeline).toEqual(timeline);
    expect(restored.turns).toEqual([]);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ sessionId: "session-1", timeline: [{ ...timeline[0], eventId: 1 }], nextCursor: null, hasMore: false }),
    });
    let older: unknown[] = [];
    await act(async () => {
      older = await result.current.fetchOlderTimeline("session-1");
    });
    expect(fetchMock.mock.calls[1][0]).toBe("/api/sessions/session-1/timeline?limit=100&before=cursor-1");
    expect(older).toHaveLength(1);
  });
});
