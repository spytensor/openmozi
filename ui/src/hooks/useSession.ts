import { useState, useCallback, useEffect } from "react";
import type { ContextCompressionState, Session, TimelineItem, TurnEnvelope } from "@/types";
import type { WorkspaceMessageContext } from "@/types/runtime";
import { useApi } from "./useApi";

const ACTIVE_SESSION_STORAGE_KEY = "mozi.ui.activeSessionId";
const SESSION_HASH_PREFIX = "#/session/";
const SESSION_PAGE_SIZE = 100;

interface SessionWorkspaceContextPayload {
  title?: string;
  workspaceRootId?: string | null;
  workspaceContext?: WorkspaceMessageContext | null;
}

function readSessionIdFromHash(hash: string): string | null | undefined {
  if (!hash.startsWith(SESSION_HASH_PREFIX)) return undefined;
  const raw = hash.slice(SESSION_HASH_PREFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function readStoredActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

function readInitialActiveSessionId(): string | null {
  if (typeof window === "undefined") return null;
  const hashSessionId = readSessionIdFromHash(window.location.hash);
  if (hashSessionId !== undefined) return hashSessionId;
  return readStoredActiveSessionId();
}

function writeStoredActiveSessionId(sessionId: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (sessionId) {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    }
  } catch {
    // Session selection still updates in-memory when local storage is unavailable.
  }
}

function writeActiveSessionHash(sessionId: string | null, mode: "push" | "replace" = "push") {
  if (typeof window === "undefined") return;
  if (sessionId) {
    const nextHash = `${SESSION_HASH_PREFIX}${encodeURIComponent(sessionId)}`;
    if (window.location.hash !== nextHash) {
      if (mode === "replace") {
        try {
          window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}${nextHash}`);
        } catch {
          window.location.hash = nextHash;
        }
      } else {
        window.location.hash = nextHash;
      }
    }
    return;
  }

  if (readSessionIdFromHash(window.location.hash) === undefined) return;
  try {
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    window.location.hash = "";
  }
}

export function useSession() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionIdState] = useState<string | null>(() => readInitialActiveSessionId());
  const [loading, setLoading] = useState(false);
  const [timelinePage, setTimelinePage] = useState<{ sessionId: string; nextCursor: string | null; hasMore: boolean }>({ sessionId: "", nextCursor: null, hasMore: false });
  const [timelineLoadingOlder, setTimelineLoadingOlder] = useState(false);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const { get, post, patch, del } = useApi();

  const applyActiveSessionId = useCallback((sessionId: string | null, mode: "push" | "replace" = "push") => {
    setActiveSessionIdState(sessionId);
    writeStoredActiveSessionId(sessionId);
    writeActiveSessionHash(sessionId, mode);
  }, []);

  const setActiveSessionId = useCallback((sessionId: string | null) => {
    applyActiveSessionId(sessionId);
  }, [applyActiveSessionId]);

  useEffect(() => {
    const handleHashChange = () => {
      const hashSessionId = readSessionIdFromHash(window.location.hash);
      if (hashSessionId !== undefined) {
        applyActiveSessionId(hashSessionId, "replace");
        return;
      }
      if (window.location.hash === "") {
        applyActiveSessionId(null, "replace");
      }
    };
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [applyActiveSessionId]);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    const loaded: Session[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;
    while (offset < total) {
      const { data } = await get<{ sessions: Session[]; total: number }>(
        `/api/sessions?limit=${SESSION_PAGE_SIZE}&offset=${offset}`,
      );
      if (!data?.sessions) break;
      loaded.push(...data.sessions);
      total = Number.isFinite(data.total) ? data.total : loaded.length;
      if (data.sessions.length === 0 || data.sessions.length < SESSION_PAGE_SIZE) break;
      offset += data.sessions.length;
    }
    const nextSessions = [...new Map(loaded.map((item) => [item.id, item])).values()];
    if (loaded.length > 0 || total === 0) {
      setSessions(nextSessions);
      if (nextSessions.length === 0) {
        applyActiveSessionId(null, "replace");
      } else if (activeSessionId && nextSessions.some((session) => session.id === activeSessionId)) {
        applyActiveSessionId(activeSessionId, "replace");
      } else if (!activeSessionId || !nextSessions.some((session) => session.id === activeSessionId)) {
        applyActiveSessionId(nextSessions[0].id, "replace");
      }
    }
    setLoading(false);
  }, [get, activeSessionId, applyActiveSessionId]);

  /**
   * Adopt a session the server just created and bound to this connection
   * (Issue #627, `session_bound`). Unlike `setActiveSessionId`, this also makes
   * the new chat appear in the sidebar: it inserts an optimistic row so the
   * entry is visible before the network round-trip, then refreshes page 0 to
   * pull the authoritative record (and later its auto-generated title). The
   * adopted id stays active regardless of the list's default selection.
   */
  const adoptSession = useCallback(async (sessionId: string) => {
    if (!sessionId) return;
    applyActiveSessionId(sessionId, "replace");
    setSessions((prev) => (prev.some((s) => s.id === sessionId)
      ? prev
      : [{ id: sessionId, title: "New Chat" }, ...prev]));
    try {
      const { data } = await get<{ sessions: Session[]; total: number }>(
        `/api/sessions?limit=${SESSION_PAGE_SIZE}&offset=0`,
      );
      const fetched = data?.sessions;
      if (fetched?.length) {
        setSessions((prev) => {
          // Keep page-0 order (newest first), then any older rows not on page 0.
          const ordered = [...fetched];
          for (const s of prev) {
            if (!fetched.some((f) => f.id === s.id)) ordered.push(s);
          }
          return [...new Map(ordered.map((s) => [s.id, s])).values()];
        });
      }
    } catch {
      // Best-effort sidebar refresh; the session is already adopted + visible.
    }
  }, [applyActiveSessionId, get]);

  const refreshSessionList = useCallback(async () => {
    const { data } = await get<{ sessions: Session[]; total: number }>(
      `/api/sessions?limit=${SESSION_PAGE_SIZE}&offset=0`,
    );
    if (!data?.sessions) return;
    setSessions((prev) => {
      const ordered = [...data.sessions];
      for (const session of prev) {
        if (!data.sessions.some((item) => item.id === session.id)) ordered.push(session);
      }
      return [...new Map(ordered.map((session) => [session.id, session])).values()];
    });
  }, [get]);

  const createSession = useCallback(async (context: SessionWorkspaceContextPayload = {}) => {
    const { data } = await post<{ session: Session; reused?: boolean }>("/api/sessions", context);
    if (data?.session) {
      setSessions((prev) => {
        const withoutCurrent = prev.filter((session) => session.id !== data.session.id);
        return [data.session, ...withoutCurrent];
      });
      setActiveSessionId(data.session.id);
      return data.session;
    }
    return null;
  }, [post]);

  const updateSessionWorkspaceContext = useCallback(async (
    id: string,
    context: SessionWorkspaceContextPayload,
  ) => {
    let previous: Session | undefined;
    setSessions((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      previous = s;
      return {
        ...s,
        execution_root_id: context.workspaceRootId ?? null,
        execution_context: context.workspaceContext ?? null,
        workspace_root_id: context.workspaceRootId ?? null,
        workspace_context: context.workspaceContext ?? null,
      };
    }));
    const { data, error } = await patch<{ session: Session }>(`/api/sessions/${id}`, context);
    if (error || !data?.session) {
      if (previous) setSessions((prev) => prev.map((s) => (s.id === id ? previous as Session : s)));
      throw new Error(error || "Failed to update execution scope");
    }
    if (data?.session) {
      setSessions((prev) => prev.map((s) => (s.id === id ? data.session : s)));
    }
  }, [patch]);

  const deleteSession = useCallback(async (id: string) => {
    await del(`/api/sessions/${id}`);
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (activeSessionId === id) {
      applyActiveSessionId(null, "replace");
    }
  }, [del, activeSessionId, applyActiveSessionId]);

  const deleteMessage = useCallback(async (sessionId: string, messageId: string) => {
    const numericId = /^conversation:(\d+)$/.exec(messageId)?.[1];
    if (!numericId) return false;
    const { data } = await del<{ ok: boolean }>(`/api/sessions/${sessionId}/messages/${numericId}`);
    return data?.ok === true;
  }, [del]);

  const fetchMessages = useCallback(async (sessionId: string) => {
    const { data } = await get<{ messages: Array<{ role: string; content: string; timestamp?: number }> }>(`/api/sessions/${sessionId}/messages?limit=10000`);
    return data?.messages || [];
  }, [get]);

  const fetchTimeline = useCallback(async (sessionId: string) => {
    setTimelineError(null);
    const { data, error } = await get<{ timeline: TimelineItem[]; nextCursor: string | null; hasMore: boolean; turns?: TurnEnvelope[] }>(`/api/sessions/${sessionId}/timeline?limit=100`);
    if (error || !data) {
      setTimelineError(error || "Timeline restore failed");
      throw new Error(error || "Timeline restore failed");
    }
    setTimelinePage({ sessionId, nextCursor: data.nextCursor, hasMore: data.hasMore });
    return { timeline: data.timeline || [], turns: data.turns || [] };
  }, [get]);

  const fetchOlderTimeline = useCallback(async (sessionId: string) => {
    if (timelineLoadingOlder || timelinePage.sessionId !== sessionId || !timelinePage.hasMore || !timelinePage.nextCursor) return [];
    setTimelineLoadingOlder(true);
    setTimelineError(null);
    const cursor = encodeURIComponent(timelinePage.nextCursor);
    const { data, error } = await get<{ timeline: TimelineItem[]; nextCursor: string | null; hasMore: boolean }>(`/api/sessions/${sessionId}/timeline?limit=100&before=${cursor}`);
    setTimelineLoadingOlder(false);
    if (error || !data) {
      setTimelineError(error || "Older timeline restore failed");
      throw new Error(error || "Older timeline restore failed");
    }
    setTimelinePage({ sessionId, nextCursor: data.nextCursor, hasMore: data.hasMore });
    return data.timeline || [];
  }, [get, timelineLoadingOlder, timelinePage]);

  const fetchContextCheckpoint = useCallback(async (sessionId: string) => {
    const { data } = await get<{ checkpoint: null | {
      status: string; stage: ContextCompressionState["stage"]; source_token_count: number;
      summary_token_count: number; model_context_window: number; updated_at: string; error?: string | null;
    } }>(`/api/sessions/${sessionId}/context-checkpoint`);
    const checkpoint = data?.checkpoint;
    if (!checkpoint) return null;
    return {
      sessionId,
      stage: checkpoint.stage,
      sourceTokens: checkpoint.source_token_count,
      summaryTokens: checkpoint.summary_token_count,
      contextWindow: checkpoint.model_context_window,
      timestamp: Date.parse(checkpoint.updated_at),
      error: checkpoint.error,
    } satisfies ContextCompressionState;
  }, [get]);

  const updateSessionTitle = useCallback((sessionId: string, title: string) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)));
  }, []);

  const updateSessionActivity = useCallback((
    sessionId: string,
    status: Session["activity_status"],
    startedAt?: number,
  ) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? {
      ...s,
      activity_status: status ?? null,
      activity_started_at: status ? (startedAt ?? s.activity_started_at ?? null) : null,
    } : s)));
  }, []);

  return {
    sessions,
    activeSessionId,
    setActiveSessionId,
    adoptSession,
    refreshSessionList,
    loading,
    fetchSessions,
    createSession,
    deleteSession,
    deleteMessage,
    fetchMessages,
    fetchTimeline,
    fetchOlderTimeline,
    timelineHasMore: timelinePage.sessionId === activeSessionId && timelinePage.hasMore,
    timelineLoadingOlder,
    timelineError,
    fetchContextCheckpoint,
    updateSessionTitle,
    updateSessionActivity,
    updateSessionWorkspaceContext,
  };
}
