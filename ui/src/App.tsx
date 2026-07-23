import { lazy, Suspense, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { PanelLeft } from "lucide-react";
import type { AppView, ChatMessage, TaskUpdate, TimelineItem, UploadedAttachment, WSInboundMessage } from "@/types";
import { useAuth } from "@/hooks/useAuth";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useChat } from "@/hooks/useChat";
import { useSession } from "@/hooks/useSession";
import { useWorkspace } from "@/hooks/useWorkspace";
import { useRuntimeWorkspace } from "@/hooks/useRuntimeWorkspace";
import { useApi } from "@/hooks/useApi";
import ChatView from "@/components/chat/ChatView";
import InputBar, { type ComposerDraftRequest, type PendingComposerAttachment } from "@/components/chat/InputBar";
import { NewChatWelcome } from "@/components/chat/NewChatWelcome";
import type { FilesAttachToChatOptions, FilesStartChatOptions } from "@/components/files/FilesView";
import { UI_FEATURES } from "@/config/features";
import type { Artifact } from "@/types";
import type { RuntimeWorkspaceRoot, WorkspaceMessageContext } from "@/types/runtime";
import { defaultRuntimeProjectRoot, pathLeaf, workspaceContextFromRoot } from "@/lib/runtime-display";
import WorkspaceSidebar, { type WorkspaceNavKey } from "@/components/layout/WorkspaceSidebar";
import { useLocale } from "@/i18n";
import { readDefaultPermissionLevel } from "@/lib/permission-default";
import { clearModelState, useModelState } from "@/hooks/useModelState";

const loadSettingsView = () => import("@/components/settings/SettingsView");
const SettingsView = lazy(loadSettingsView);
const LoginPage = lazy(() => import("@/components/auth/LoginPage"));
const OnboardingWizard = lazy(() => import("@/components/onboarding/OnboardingWizard"));
const AdminShell = lazy(() => import("@/components/admin/AdminShell"));
const ScheduledView = lazy(() => import("@/components/scheduler/ScheduledView"));
const SkillsView = lazy(() => import("@/components/skills/SkillsView"));
const FilesView = lazy(() => import("@/components/files/FilesView"));
const ArtifactPanel = lazy(() => import("@/components/chat/ArtifactPanel"));

function LazySurfaceFallback() {
  return <div className="min-h-0 flex-1 bg-surface" data-testid="lazy-surface-loading" />;
}

const SELECTED_ROOT_STORAGE_KEY = "mozi.ui.selectedRootId";
const SIDEBAR_COLLAPSED_STORAGE_KEY = "mozi.ui.sidebarCollapsed";
const GENERAL_ROOT_STORAGE_VALUE = "__general__";
const VIEW_STORAGE_KEY = "mozi.ui.view";
// `memory` is a Settings category, not a standalone workspace surface. Older
// builds could persist that dead view and restore a blank main area.
const RESTORABLE_VIEWS: readonly AppView[] = ["chat", "scheduled", "skills", "files", "settings"];

function readStoredView(): AppView {
  if (typeof window === "undefined") return "chat";
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY) as AppView | null;
    return stored && RESTORABLE_VIEWS.includes(stored) ? stored : "chat";
  } catch {
    return "chat";
  }
}

function navForView(view: AppView): WorkspaceNavKey {
  return view === "chat" ? "chats" : (view as WorkspaceNavKey);
}
const ARTIFACT_PANEL_WIDTH_STORAGE_KEY = "mozi.ui.artifactPanelWidth";
const ARTIFACT_PANEL_DEFAULT_RATIO = 0.5;
const ARTIFACT_PANEL_MIN_WIDTH = 380;
// Expanded workspace sidebar width (see WorkspaceSidebar `w-[248px]`). The
// dock math must subtract it, or the chat column silently collapses behind it.
const SIDEBAR_WIDTH = 248;
// The chat column never docks narrower than this — below it the composer chip
// tray overlaps and prose wraps one glyph per line. When the window can't fit a
// usable chat AND the panel side by side, the artifact panel takes over the full
// area instead (undocked = `left-0 w-full`), rather than cramming both.
const MIN_CHAT_WIDTH = 460;

/** Main-content width (viewport minus the expanded sidebar). */
function mainAreaWidth(sidebarCollapsed: boolean, viewportWidth = typeof window === "undefined" ? 1440 : window.innerWidth): number {
  return viewportWidth - (sidebarCollapsed ? 0 : SIDEBAR_WIDTH);
}

/**
 * The panel is docked (side-by-side with chat) only while a usable chat column
 * still fits beside it. Because the drag clamp keeps MIN_CHAT_WIDTH free (see
 * clampArtifactPanelWidth), dragging can never undock — only a window/sidebar
 * change that leaves too little room for both columns flips the panel to the
 * full-width takeover. Full-width on a wide window is the fullscreen button's
 * job, never a drag side effect (operator decision 2026-07-18: the surprise
 * mid-drag takeover — which also removed the resize handle, trapping the
 * panel wide — was disorienting).
 */
export function isArtifactDocked(panelWidth: number, sidebarCollapsed: boolean, viewportWidth?: number): boolean {
  return mainAreaWidth(sidebarCollapsed, viewportWidth) - panelWidth >= MIN_CHAT_WIDTH;
}

type SelectedRootId = string | null | undefined;

function readStoredRootId(): SelectedRootId {
  if (typeof window === "undefined") return undefined;
  try {
    const value = window.localStorage.getItem(SELECTED_ROOT_STORAGE_KEY);
    if (value === null) return undefined;
    return value === GENERAL_ROOT_STORAGE_VALUE ? null : value;
  } catch {
    return undefined;
  }
}

export function clampArtifactPanelWidth(width: number, sidebarCollapsed = false, viewportWidth?: number): number {
  // Drag stops where the chat column would fall below its minimum — a drag is
  // a resize, never a mode switch. (On windows too narrow to fit panel-min +
  // chat-min the lower bound wins and isArtifactDocked() still flips to the
  // takeover, which is the responsive case, not the drag case.)
  const maxWidth = Math.max(ARTIFACT_PANEL_MIN_WIDTH, mainAreaWidth(sidebarCollapsed, viewportWidth) - MIN_CHAT_WIDTH);
  return Math.round(Math.min(Math.max(width, ARTIFACT_PANEL_MIN_WIDTH), maxWidth));
}

function readArtifactPanelWidth(): number {
  if (typeof window === "undefined") return 720;
  try {
    const stored = Number(window.localStorage.getItem(ARTIFACT_PANEL_WIDTH_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampArtifactPanelWidth(stored);
  } catch {
    // Fall through to viewport-based default.
  }
  return clampArtifactPanelWidth(window.innerWidth * ARTIFACT_PANEL_DEFAULT_RATIO);
}

function artifactTurnId(artifact: Artifact): string | null {
  const meta = artifact.data.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const turnId = (meta as { turn_id?: unknown }).turn_id;
  return typeof turnId === "string" && turnId.trim() ? turnId : null;
}


function rootKindFromContext(kind: WorkspaceMessageContext["rootKind"]): RuntimeWorkspaceRoot["kind"] {
  return kind === "mozi_home" || kind === "workspace" || kind === "allowed_root" || kind === "project_root"
    ? kind
    : "project_root";
}

function rootFromSessionContext(
  sessionId: string,
  rootId: string | null | undefined,
  context: WorkspaceMessageContext | null | undefined,
): RuntimeWorkspaceRoot | null {
  if (!context?.rootPath) return null;
  return {
    id: rootId || `session:${sessionId}:workspace`,
    kind: rootKindFromContext(context.rootKind),
    label: context.label || context.rootPath.split("/").filter(Boolean).at(-1) || context.rootPath,
    path: context.rootPath,
    exists: true,
    git: context.gitBranch ? { is_repo: true, branch: context.gitBranch } : undefined,
  };
}

function parentPath(path: string): string {
  return path.replace(/[\\/][^\\/]+[\\/]?$/, "") || path;
}

export default function App() {
  const { t } = useLocale();
  const auth = useAuth();
  const [view, setView] = useState<AppView>(() => readStoredView());
  const lastWorkspaceViewRef = useRef<AppView>(readStoredView() === "settings" ? "chat" : readStoredView());
  const [activeNav, setActiveNav] = useState<WorkspaceNavKey>(() => navForView(readStoredView()));
  const [settingsInitialCategory, setSettingsInitialCategory] = useState<"general" | "models" | "memory">("general");
  const [activeArtifact, setActiveArtifact] = useState<Artifact | null>(null);
  const [artifactPanelWidth, setArtifactPanelWidth] = useState(() => readArtifactPanelWidth());
  const [artifactFullscreen, setArtifactFullscreen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
  const [artifactResizing, setArtifactResizing] = useState(false);
  const [selectedRootId, setSelectedRootId] = useState<SelectedRootId>(() => readStoredRootId());
  const [transientSelectedRoot, setTransientSelectedRoot] = useState<RuntimeWorkspaceRoot | null>(null);
  const [scopeUpdateError, setScopeUpdateError] = useState<string | null>(null);
  const [pendingComposerAttachment, setPendingComposerAttachment] = useState<PendingComposerAttachment | null>(null);
  const [pendingComposerDraft, setPendingComposerDraft] = useState<ComposerDraftRequest | null>(null);
  const pendingComposerAttachmentIdRef = useRef(0);
  const pendingComposerDraftIdRef = useRef(0);
  const scopeTransitionRef = useRef<Promise<void> | null>(null);
  const restoredSessionIdRef = useRef<string | null>(null);
  const liveBoundSessionRef = useRef<string | null>(null);

  // Persist the active view so a refresh stays on Files/Skills/Settings/etc.
  // instead of snapping back to chat. (admin is intentionally not restored.)
  useEffect(() => {
    try {
      if (RESTORABLE_VIEWS.includes(view)) window.localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch { /* storage unavailable — view just won't persist */ }
    if (view !== "settings" && view !== "admin") lastWorkspaceViewRef.current = view;
  }, [view]);

  const contentView = view === "settings" ? lastWorkspaceViewRef.current : view;
  const closeSettings = useCallback(() => {
    const nextView = lastWorkspaceViewRef.current;
    setView(nextView);
    setActiveNav(navForView(nextView));
  }, []);
  const openModelSettings = useCallback(() => {
    setSettingsInitialCategory("models");
    setView("settings");
    setActiveNav(navForView("settings"));
  }, []);
  const openMemory = useCallback(() => {
    setSettingsInitialCategory("memory");
    setView("settings");
    setActiveNav(navForView("settings"));
  }, []);

  const session = useSession();
  const chat = useChat(session.activeSessionId);
  const workspace = useWorkspace();
  const runtimeWorkspace = useRuntimeWorkspace(auth.state === "ready");
  useModelState(auth.state === "ready");
  useEffect(() => {
    if (auth.state !== "ready") clearModelState();
  }, [auth.state]);
  useEffect(() => {
    if (auth.state !== "ready") return;
    const preload = () => { void loadSettingsView(); };
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(preload);
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(preload, 250);
    return () => window.clearTimeout(id);
  }, [auth.state]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // In-memory toggle still works without local storage.
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);
  const { patch: apiPatch } = useApi();
  const projectContextEnabled = UI_FEATURES.projectContext;
  const runtimeRoots = runtimeWorkspace.snapshot?.roots ?? [];
  const isAdmin = auth.user?.role === "admin";
  const activeSession = useMemo(
    () => session.sessions.find((s) => s.id === session.activeSessionId) ?? null,
    [session.activeSessionId, session.sessions],
  );
  const selectedRoot = useMemo(() => {
    if (!projectContextEnabled) return null;
    if (selectedRootId === null) return null;
    return runtimeRoots.find((root) => root.id === selectedRootId)
      ?? (transientSelectedRoot?.id === selectedRootId ? transientSelectedRoot : null)
      ?? rootFromSessionContext(
        activeSession?.id ?? "draft",
        activeSession?.execution_root_id ?? activeSession?.workspace_root_id,
        activeSession?.execution_context ?? activeSession?.workspace_context,
      )
      ?? defaultRuntimeProjectRoot(runtimeRoots);
  }, [activeSession, projectContextEnabled, runtimeRoots, selectedRootId, transientSelectedRoot]);

  const handleSelectRoot = useCallback((root: RuntimeWorkspaceRoot | null) => {
    if (!projectContextEnabled) return;
    const nextId = root?.id ?? null;
    const nextContext = root ? workspaceContextFromRoot(root) : null;
    const previousId = selectedRootId ?? null;
    const previousRoot = selectedRoot;
    setScopeUpdateError(null);
    setSelectedRootId(nextId);
    setTransientSelectedRoot(root);
    try {
      if (nextId) {
        window.localStorage.setItem(SELECTED_ROOT_STORAGE_KEY, nextId);
      } else {
        window.localStorage.setItem(SELECTED_ROOT_STORAGE_KEY, GENERAL_ROOT_STORAGE_VALUE);
      }
    } catch {
      // Project context still updates in-memory when local storage is unavailable.
    }
    if (session.activeSessionId) {
      const transition = session.updateSessionWorkspaceContext(session.activeSessionId, {
        workspaceRootId: nextId,
        workspaceContext: nextContext,
      });
      scopeTransitionRef.current = transition;
      void transition.catch((error) => {
        setSelectedRootId(previousId);
        setTransientSelectedRoot(previousRoot);
        setScopeUpdateError(t("project.scope.updateFailed", {
          error: error instanceof Error ? error.message : String(error),
        }));
      }).finally(() => {
        if (scopeTransitionRef.current === transition) scopeTransitionRef.current = null;
      });
    }
  }, [projectContextEnabled, selectedRoot, selectedRootId, session.activeSessionId, session.updateSessionWorkspaceContext, t]);

  const handleWSMessage = useCallback((msg: WSInboundMessage) => {
    if (msg.type === "session_bound") {
      chat.adoptResolvedSession(msg.sessionId);
      liveBoundSessionRef.current = msg.sessionId;
      void session.adoptSession(msg.sessionId);
      return;
    }
    if (msg.type === "session_activity") {
      session.updateSessionActivity(msg.sessionId, msg.status, msg.startedAt);
      return;
    }
    if (msg.type === "session_list_changed") {
      void session.refreshSessionList();
      return;
    }
    const accepted = chat.handleWSMessage(msg);
    if (!accepted) return;
    // A cancelled turn deserves an explicit, correctly attributed acknowledgment.
    // The marker's detail carries the abort reason set by the backend: a stop the
    // user clicked reads differently from a runtime restart. Other reasons (turn
    // superseded by a new message) stay quiet on purpose.
    {
      const raw = msg as Record<string, unknown>;
      if (msg.type === "task_progress" && raw.status === "failed" && raw.rawStatus === "CANCELLED") {
        const detail = typeof raw.detail === "string" ? raw.detail : "";
        if (detail.startsWith("User requested cancellation")) {
          chat.addMessage("system", t("chat.stoppedByUser"));
        } else if (detail.startsWith("Runtime restarting")) {
          chat.addMessage("system", t("chat.interruptedByRestart"));
        }
      }
    }
    if (msg.type.startsWith("workspace_")) {
      workspace.handleWSMessage(msg);
      const raw = msg as Record<string, unknown>;
      if (msg.type === "workspace_state") {
        const state = raw.state as Record<string, unknown> | undefined;
        if (state?.model) chat.setCurrentModel(state.model as string);
      }
      if (msg.type === "workspace_providers" && Array.isArray(raw.providers) && raw.providers[0]?.model) {
        chat.setCurrentModel(raw.providers[0].model as string);
      }
    }
    if (msg.type === "session_update" && "sessionId" in msg && "title" in msg) {
      session.updateSessionTitle(msg.sessionId as string, msg.title as string);
    }
    if (msg.type === "approval_resolved" && msg.status === "approved") {
      const raw = msg as Record<string, unknown>;
      const sessionId = typeof raw.sessionId === "string" ? raw.sessionId : "";
      const permissionLevel = typeof raw.permission_level === "string" ? raw.permission_level : undefined;
      if (sessionId && permissionLevel) {
        window.dispatchEvent(new CustomEvent("mozi:permission-level-updated", {
          detail: {
            sessionId,
            permission_level: permissionLevel,
          },
        }));
      }
    }
    // Artifacts land as inline cards in the timeline; the workspace opens
    // only on an explicit user click (never automatically).
  }, [chat.handleWSMessage, chat.addMessage, chat.setCurrentModel, chat.adoptResolvedSession, workspace.handleWSMessage, session.updateSessionTitle, session.updateSessionActivity, session.adoptSession, session.refreshSessionList, t]);

  const ws = useWebSocket({ onMessage: handleWSMessage, enabled: auth.state === "ready" });
  const timelineRefreshEpoch = ws.connectionEpoch > 1 ? ws.connectionEpoch : 0;

  useEffect(() => {
    if (workspace.enabled && ws.status === "connected") {
      ws.send({ type: "subscribe_workspace" });
    }
  }, [workspace.enabled, ws.status]);

  useEffect(() => {
    if (ws.status !== "connected") return;
    ws.send({
      type: "select_session",
      ...(session.activeSessionId ? { sessionId: session.activeSessionId } : {}),
    });
  }, [session.activeSessionId, ws.connectionEpoch, ws.send, ws.status]);

  useEffect(() => {
    if (auth.state === "ready") {
      session.fetchSessions();
    }
  }, [auth.state]);

  useEffect(() => {
    // activeSessionId is restored synchronously from localStorage/hash, so this
    // effect fires on mount — before useAuth finishes its silent cookie refresh.
    // Fetching then guarantees a 401 restore error; wait for auth instead.
    if (auth.state !== "ready") return;
    if (!session.activeSessionId) {
      chat.clearTimeline();
      chat.setContextCompression(null);
      return;
    }

    let cancelled = false;
    const sessionId = session.activeSessionId;
    if (liveBoundSessionRef.current === sessionId) {
      // The draft timeline is already live. Restoring immediately can race the
      // first stream and replace newer chunks with an earlier DB snapshot.
      liveBoundSessionRef.current = null;
      restoredSessionIdRef.current = sessionId;
      return;
    }
    if (restoredSessionIdRef.current !== sessionId) {
      chat.clearTimeline();
      restoredSessionIdRef.current = sessionId;
    }
    session.fetchTimeline(sessionId)
      .then(({ timeline, turns }) => {
        if (cancelled) return;
        if (timeline.length > 0) {
          chat.loadTimeline(timeline);
          chat.loadTurns(turns);
          return;
        }
        return session.fetchMessages(sessionId).then((msgs) => {
          if (!cancelled) chat.loadHistory(msgs);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        // Keep the previous session cleared and show the explicit restore error.
        // A partial plain-message fallback would silently drop tools/artifacts.
        console.warn("[restore] timeline fetch failed", err);
      });

    return () => {
      cancelled = true;
    };
  }, [
    auth.state,
    session.activeSessionId,
    timelineRefreshEpoch,
    session.fetchTimeline,
    session.fetchMessages,
    chat.loadTimeline,
    chat.loadHistory,
    chat.clearTimeline,
  ]);

  useEffect(() => {
    if (auth.state !== "ready") return;
    const sessionId = session.activeSessionId;
    if (!sessionId) return;
    let cancelled = false;
    chat.setContextCompression(null);
    session.fetchContextCheckpoint(sessionId).then((checkpoint) => {
      if (!cancelled) chat.setContextCompression(checkpoint);
    }).catch(() => {
      // Supplementary status must never block conversation restore.
    });
    return () => { cancelled = true; };
  }, [auth.state, session.activeSessionId, session.fetchContextCheckpoint, chat.setContextCompression]);

  useEffect(() => {
    if (!activeArtifact) return;
    const latest = chat.timeline.find(
      (item) => item.type === "artifact" && (item.data as Artifact).id === activeArtifact.id,
    )?.data as Artifact | undefined;
    if (!latest) return;
    // The runtime closed this artifact — honor it instead of showing stale chrome.
    if (latest.status === "closed") {
      setActiveArtifact(null);
      return;
    }
    if (latest !== activeArtifact) {
      setActiveArtifact(latest);
    }
  }, [activeArtifact, chat.timeline]);

  // Artifacts NEVER auto-open (operator decision 2026-07-18, restoring the
  // original click-to-open contract from the P2.1 canvas overhaul): a panel
  // taking over the screen mid-run yanks the user away from the conversation.
  // The chat card and the workbench remain one click away.

  useEffect(() => {
    setArtifactFullscreen(false);
  }, [activeArtifact?.id]);

  useEffect(() => {
    setActiveArtifact(null);
    setArtifactFullscreen(false);
  }, [session.activeSessionId]);

  const handleOpenArtifact = useCallback((artifact: Artifact) => {
    setActiveArtifact(artifact);
  }, []);

  const handleCloseArtifact = useCallback(() => {
    setActiveArtifact(null);
  }, []);

  useEffect(() => {
    const onResize = () => {
      setViewportWidth(window.innerWidth);
      // Keep the stored width within the (now possibly smaller) window.
      setArtifactPanelWidth((width) => clampArtifactPanelWidth(width, sidebarCollapsed));
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [sidebarCollapsed]);

  // Derived: whether the panel docks beside the chat or takes over full-width.
  const artifactDocked = isArtifactDocked(artifactPanelWidth, sidebarCollapsed, viewportWidth);

  const handleArtifactResize = useCallback((width: number): number => {
    const nextWidth = clampArtifactPanelWidth(width, sidebarCollapsed);
    setArtifactPanelWidth(nextWidth);
    try {
      window.localStorage.setItem(ARTIFACT_PANEL_WIDTH_STORAGE_KEY, String(nextWidth));
    } catch {
      // Width still updates for the current session when storage is unavailable.
    }
    return nextWidth;
  }, [sidebarCollapsed]);
  const handleArtifactResizeStart = useCallback(() => {
    setArtifactResizing(true);
  }, []);
  const handleArtifactResizeEnd = useCallback(() => {
    setArtifactResizing(false);
  }, []);

  useEffect(() => {
    if (!projectContextEnabled) return;
    if (!selectedRootId || !runtimeWorkspace.snapshot) return;
    const stillAvailable = runtimeWorkspace.snapshot.roots.some((root) => root.id === selectedRootId);
    const restoredFromSession = (activeSession?.execution_root_id ?? activeSession?.workspace_root_id) === selectedRootId
      && !!(activeSession?.execution_context ?? activeSession?.workspace_context);
    if (!stillAvailable && !restoredFromSession) handleSelectRoot(null);
  }, [activeSession, handleSelectRoot, projectContextEnabled, runtimeWorkspace.snapshot, selectedRootId]);

  useEffect(() => {
    if (!projectContextEnabled) {
      setSelectedRootId(null);
      try {
        window.localStorage.removeItem(SELECTED_ROOT_STORAGE_KEY);
      } catch {
        // Chat-only MVP ignores persisted project context.
      }
      return;
    }
    if (!session.activeSessionId) return;
    const nextId = activeSession?.execution_root_id ?? activeSession?.workspace_root_id ?? null;
    setSelectedRootId(nextId);
    try {
      if (nextId) {
        window.localStorage.setItem(SELECTED_ROOT_STORAGE_KEY, nextId);
      } else {
        window.localStorage.setItem(SELECTED_ROOT_STORAGE_KEY, GENERAL_ROOT_STORAGE_VALUE);
      }
    } catch {
      // Session-bound project context still restores in memory without local storage.
    }
  }, [activeSession?.execution_root_id, activeSession?.workspace_root_id, projectContextEnabled, session.activeSessionId]);

  const sendRuntimeMessage = useCallback(async (
    content: string,
    targetSessionId?: string,
    attachments?: UploadedAttachment[],
    regenerate = false,
    beforeSend?: () => void,
  ) => {
    try {
      await scopeTransitionRef.current;
    } catch {
      return false;
    }
    beforeSend?.();
    chat.setSessionState("WORKING");
    ws.send({
      type: "message",
      content,
      sessionId: targetSessionId || session.activeSessionId || undefined,
      ...(regenerate ? { regenerate: true } : {}),
      ...(attachments?.length
        ? { attachments: attachments.map(({ filename, path }) => ({ filename, path })) }
        : {}),
    });
    return true;
  }, [ws.send, chat.setSessionState, session.activeSessionId]);

  const handleSend = useCallback(async (content: string, attachments?: UploadedAttachment[]) => {
    await sendRuntimeMessage(content, undefined, attachments, false, () => {
      chat.addMessage("user", content, undefined, undefined, attachments);
    });
  }, [chat.addMessage, sendRuntimeMessage]);

  const handleRegenerate = useCallback(async (content: string) => {
    chat.prepareRegenerate(content);
    await sendRuntimeMessage(content, undefined, undefined, true);
  }, [chat.prepareRegenerate, sendRuntimeMessage]);

  const handleCancelTurn = useCallback(() => {
    if (chat.sessionState === "IDLE") return;
    ws.send({
      type: "cancel_turn",
      sessionId: session.activeSessionId || undefined,
    });
  }, [chat.sessionState, ws.send, session.activeSessionId]);

  const handleApprove = useCallback((id: string, scope?: "once" | "session") => {
    // Optimistic terminal state — the card must react to the click immediately,
    // not wait for the server ack (which may be delayed or filtered).
    chat.resolveApproval(id, true);
    ws.send({ type: "approve", id, sessionId: session.activeSessionId || undefined, ...(scope ? { scope } : {}) });
  }, [ws.send, chat.resolveApproval, session.activeSessionId]);

  const handleReject = useCallback((id: string) => {
    chat.resolveApproval(id, false);
    ws.send({ type: "reject", id, sessionId: session.activeSessionId || undefined });
  }, [ws.send, chat.resolveApproval, session.activeSessionId]);

  const applyDefaultPermissionLevel = useCallback(async (sessionId: string) => {
    const defaultPermissionLevel = readDefaultPermissionLevel();
    if (!defaultPermissionLevel) return;
    await apiPatch(`/api/sessions/${sessionId}/permission-level`, {
      permission_level: defaultPermissionLevel,
    });
  }, [apiPatch]);

  const queueComposerAttachment = useCallback((attachment: UploadedAttachment) => {
    pendingComposerAttachmentIdRef.current += 1;
    setPendingComposerAttachment({
      id: pendingComposerAttachmentIdRef.current,
      attachment,
    });
  }, []);

  const clearPendingComposerAttachment = useCallback((id: number) => {
    setPendingComposerAttachment((current) => (current?.id === id ? null : current));
  }, []);

  const handleSessionSelect = useCallback((id: string) => {
    session.setActiveSessionId(id);
    setActiveNav("chats");
    setView("chat");
  }, [session.setActiveSessionId]);

  const handleCreateSession = useCallback(async () => {
    const s = await session.createSession({
      workspaceRootId: projectContextEnabled ? selectedRoot?.id ?? null : null,
      workspaceContext: projectContextEnabled && selectedRoot ? workspaceContextFromRoot(selectedRoot) : null,
    });
    if (s) {
      await applyDefaultPermissionLevel(s.id);
      chat.clearTimeline();
      setActiveNav("chats");
      setView("chat");
    }
  }, [applyDefaultPermissionLevel, chat.clearTimeline, projectContextEnabled, selectedRoot, session.createSession]);

  const handleFilesStartChat = useCallback(async (opts: FilesStartChatOptions) => {
    const folderPath = opts.folderPath.trim();
    if (!folderPath) return;
    const label = opts.label.trim() || pathLeaf(folderPath);
    // Do NOT title the session after the folder/file — the project group header
    // already shows the folder, so a same-named session reads as a confusing
    // duplicate (PROJECTS ▸ artifacts / artifacts). Leave the title to MOZI's
    // auto-title (derived from the first message), which describes the chat.
    const matchingRoot = runtimeRoots.find((root) => root.path === folderPath || root.id === folderPath);
    const canonicalPath = matchingRoot?.path ?? folderPath;
    const canonicalId = matchingRoot?.id ?? `project_root:${canonicalPath}`;
    const s = await session.createSession({
      workspaceRootId: canonicalId,
      workspaceContext: {
        rootPath: canonicalPath,
        rootKind: matchingRoot?.kind ?? "project_root",
        label,
        gitBranch: matchingRoot?.git?.branch,
      },
    });
    if (!s) return;
    await applyDefaultPermissionLevel(s.id);
    chat.clearTimeline();
    setSelectedRootId(canonicalId);
    try {
      window.localStorage.setItem(SELECTED_ROOT_STORAGE_KEY, canonicalId);
    } catch {
      // Session-bound context still works without local storage.
    }
    if (opts.attachPath) {
      queueComposerAttachment({
        filename: opts.attachFilename || pathLeaf(opts.attachPath),
        path: opts.attachPath,
      });
    }
    setActiveNav("chats");
    setView("chat");
  }, [applyDefaultPermissionLevel, chat.clearTimeline, queueComposerAttachment, runtimeRoots, session.createSession]);

  const handleFilesAttachToChat = useCallback(async (opts: FilesAttachToChatOptions) => {
    if (!session.activeSessionId) {
      const folderPath = parentPath(opts.path);
      await handleFilesStartChat({
        folderPath,
        label: pathLeaf(folderPath),
        attachPath: opts.path,
        attachFilename: opts.filename,
      });
      return;
    }
    queueComposerAttachment({ filename: opts.filename, path: opts.path });
    setActiveNav("chats");
    setView("chat");
  }, [handleFilesStartChat, queueComposerAttachment, session.activeSessionId]);

  const handleBackToWorkspace = useCallback(() => {
    setActiveNav("chats");
    setView("chat");
  }, []);

  const handleDeleteMessage = useCallback(async (message: ChatMessage) => {
    const sessionId = session.activeSessionId;
    if (!sessionId) return;
    const confirmation = message.role === "user"
      ? t("chat.deleteUserConfirm")
      : t("chat.deleteAssistantConfirm");
    if (!window.confirm(confirmation)) return;
    const deleted = await session.deleteMessage(sessionId, message.id);
    if (!deleted) return;
    const { timeline, turns } = await session.fetchTimeline(sessionId);
    chat.loadTimeline(timeline);
    chat.loadTurns(turns);
    void session.fetchSessions();
  }, [chat.loadTimeline, chat.loadTurns, session, t]);

  const handleLoadOlderTimeline = useCallback(async () => {
    const sessionId = session.activeSessionId;
    if (!sessionId) return;
    try {
      const older = await session.fetchOlderTimeline(sessionId);
      chat.prependTimeline(older);
    } catch {
      // useSession exposes the translated inline error surface below.
    }
  }, [chat.prependTimeline, session.activeSessionId, session.fetchOlderTimeline]);

  // Auth gates
  if (auth.state === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-base">
        <div className="text-center">
          <p className="text-xl font-bold text-action mb-2">{t("app.productName")}</p>
          <p className="text-xs text-ink/40">{t("app.connecting")}</p>
        </div>
      </div>
    );
  }

  if (auth.state === "login") {
    return (
      <Suspense fallback={<LazySurfaceFallback />}><LoginPage
        error={auth.error}
        oauthProviders={auth.oauthProviders}
        authMode={auth.authMode}
        registrationPolicy={auth.registrationPolicy}
        bootstrapAvailable={auth.bootstrapAvailable}
        onAuthenticated={auth.refreshAuth}
      /></Suspense>
    );
  }

  if (auth.state === "onboarding") {
    return <Suspense fallback={<LazySurfaceFallback />}><OnboardingWizard onComplete={auth.completeOnboarding} /></Suspense>;
  }

  const showEmptyWorkspace = contentView === "chat" && chat.timeline.length === 0 && chat.sessionState === "IDLE";

  if (view === "admin") {
    return (
      <Suspense fallback={<LazySurfaceFallback />}><AdminShell
        currentUser={auth.user ?? null}
        onBackToWorkspace={handleBackToWorkspace}
      /></Suspense>
    );
  }

  return (
    <div className="h-screen overflow-hidden bg-base">
      {scopeUpdateError && (
        <div role="alert" className="fixed left-1/2 top-3 z-[100] -translate-x-1/2 rounded-md border border-red-400/30 bg-red-950 px-4 py-2 text-sm text-red-100 shadow-lg">
          {scopeUpdateError}
        </div>
      )}
      {session.timelineError && (
        <div role="alert" className="fixed left-1/2 top-14 z-[100] -translate-x-1/2 rounded-md border border-red-400/30 bg-red-950 px-4 py-2 text-sm text-red-100 shadow-lg">
          {t("chat.history.restoreFailed", { error: session.timelineError })}
        </div>
      )}
      <div className="flex h-full min-h-0 w-full overflow-hidden" style={{ background: "var(--surface-base)" }}>
        <WorkspaceSidebar
          active={activeNav}
          sessions={session.sessions}
          activeSessionId={session.activeSessionId}
          projectsEnabled
          roots={runtimeRoots}
          runtimeLoading={runtimeWorkspace.loading}
          isAdmin={isAdmin}
          selectedRootId={projectContextEnabled ? selectedRootId : null}
          collapsed={sidebarCollapsed}
          onToggleCollapse={toggleSidebar}
          onNavChange={setActiveNav}
          onViewChange={(nextView) => {
            if (nextView === "settings") setSettingsInitialCategory("general");
            setView(nextView);
          }}
          onSelectSession={handleSessionSelect}
          onSelectRoot={handleSelectRoot}
          onCreateSession={handleCreateSession}
          onNewProjectSession={(rootId, label) => {
            const root = runtimeRoots.find((candidate) => candidate.id === rootId);
            if (root) void handleFilesStartChat({ folderPath: root.path, label });
          }}
          onDeleteSession={session.deleteSession}
          onLogout={auth.logout}
        />

        <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden" style={{ background: "var(--main-bg)" }}>
          {sidebarCollapsed && (
            <button
              type="button"
              data-testid="sidebar-expand"
              aria-label={t("sidebar.expand")}
              title={`${t("sidebar.expand")} (⌘B)`}
              onClick={toggleSidebar}
              className="absolute left-3 top-3 z-30 hidden h-7 w-7 items-center justify-center rounded-md border transition-colors hover:bg-ink/[0.05] md:flex"
              style={{
                background: "var(--surface-elevated)",
                borderColor: "var(--border-subtle)",
                color: "var(--text-muted)",
              }}
            >
              <PanelLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <div
            data-testid="chat-shell"
            className={artifactResizing ? "flex h-full min-h-0 flex-col" : "flex h-full min-h-0 flex-col transition-[margin-right] duration-200"}
            style={{
              marginRight: activeArtifact && !artifactFullscreen && artifactDocked ? `${artifactPanelWidth}px` : "0",
            }}
          >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              {contentView === "chat" && (
                showEmptyWorkspace ? (
                  <section
                    data-testid="empty-workspace"
                    className="flex min-h-0 flex-1 flex-col px-5 sm:px-8"
                  >
                    <div
                      data-testid="empty-workspace-welcome"
                      className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto py-6"
                    >
                      <div className="w-full max-w-[900px]">
                        <NewChatWelcome
                          onSelectPrompt={(text) => {
                            pendingComposerDraftIdRef.current += 1;
                            setPendingComposerDraft({ id: pendingComposerDraftIdRef.current, text });
                          }}
                        />
                      </div>
                    </div>
                    <div
                      data-testid="empty-workspace-composer"
                      className="mx-auto w-full max-w-[900px] shrink-0 pb-3 pt-2"
                    >
                      <InputBar
                        variant="empty"
                        onSend={handleSend}
                        onCancel={handleCancelTurn}
                        connectionStatus={ws.status}
                        queueCount={chat.queue.length}
                        isWorking={chat.sessionState !== "IDLE"}
                        roots={runtimeRoots}
                        selectedRoot={selectedRoot}
                        onSelectRoot={handleSelectRoot}
                        workspaceContextEnabled={projectContextEnabled}
                        attachmentControlsEnabled={UI_FEATURES.composerAttachments}
                        mentionControlsEnabled={UI_FEATURES.composerMentions}
                        sessionId={session.activeSessionId}
                        pendingAttachment={pendingComposerAttachment}
                        onPendingAttachmentConsumed={clearPendingComposerAttachment}
                        onRootsChanged={runtimeWorkspace.refresh}
                        contextCompression={chat.contextCompression}
                        draftRequest={pendingComposerDraft}
                        onDraftRequestConsumed={(id) => {
                          setPendingComposerDraft((current) => current?.id === id ? null : current);
                        }}
                        canConfigureModels={isAdmin}
                        onOpenModelSettings={openModelSettings}
                      />
                    </div>
                  </section>
                ) : (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <ChatView
                      sessionId={session.activeSessionId}
                      hasOlderHistory={session.timelineHasMore}
                      loadingOlderHistory={session.timelineLoadingOlder}
                      onLoadOlderHistory={() => void handleLoadOlderTimeline()}
                      timeline={chat.timeline}
                      sessionState={chat.sessionState}
                      activeTool={chat.activeTool}
                      activeToolSkillName={chat.activeToolSkillName}
                      activeTurnId={chat.activeTurnId}
                      timelineCapabilities={chat.timelineCapabilities}
                      turns={chat.turns}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onSend={handleSend}
                      onRegenerate={handleRegenerate}
                      onDeleteMessage={handleDeleteMessage}
                      onOpenArtifact={handleOpenArtifact}
                      onOpenModelSettings={openModelSettings}
                      onOpenMemory={openMemory}
                    />
                    <div data-testid="composer-dock" className="shrink-0 px-5 pb-3 pt-2">
                      <div data-testid="composer-reading-rail" className="mx-auto w-full max-w-[960px] px-4">
                        <InputBar
                          variant="active"
                          onSend={handleSend}
                          onCancel={handleCancelTurn}
                          connectionStatus={ws.status}
                          queueCount={chat.queue.length}
                          isWorking={chat.sessionState !== "IDLE"}
                          roots={runtimeRoots}
                          selectedRoot={selectedRoot}
                          onSelectRoot={handleSelectRoot}
                          workspaceContextEnabled={projectContextEnabled}
                          attachmentControlsEnabled={UI_FEATURES.composerAttachments}
                          mentionControlsEnabled={UI_FEATURES.composerMentions}
                          sessionId={session.activeSessionId}
                          pendingAttachment={pendingComposerAttachment}
                          onPendingAttachmentConsumed={clearPendingComposerAttachment}
                          onRootsChanged={runtimeWorkspace.refresh}
                          contextCompression={chat.contextCompression}
                          canConfigureModels={isAdmin}
                          onOpenModelSettings={openModelSettings}
                        />
                      </div>
                    </div>
                  </div>
                )
              )}
              {contentView === "skills" && (
                <Suspense fallback={<LazySurfaceFallback />}><SkillsView /></Suspense>
              )}
              {contentView === "files" && (
                <Suspense fallback={<LazySurfaceFallback />}><FilesView
                  onOpenArtifact={handleOpenArtifact}
                  onStartChat={handleFilesStartChat}
                  onAttachToChat={handleFilesAttachToChat}
                  onOpenSession={handleSessionSelect}
                  roots={runtimeRoots}
                /></Suspense>
              )}
              {contentView === "scheduled" && (
                <Suspense fallback={<LazySurfaceFallback />}><ScheduledView onOpenSession={handleSessionSelect} /></Suspense>
              )}
            </div>
          </div>

          {/* The floating execution HUD retired with the in-chat plan card
              (four-region model): the plan renders inside the conversation —
              live phase states while running, plan-as-spine in the fold after —
              so a second floating surface would be a competing duplicate. */}
        </main>
      </div>

      {view === "settings" && (
        <Suspense fallback={null}><SettingsView
          initialCategory={settingsInitialCategory}
          snapshot={runtimeWorkspace.snapshot}
          logs={runtimeWorkspace.logs}
          health={runtimeWorkspace.health}
          service={runtimeWorkspace.service}
          runtimeLoading={runtimeWorkspace.loading}
          serviceBusy={runtimeWorkspace.serviceBusy}
          error={runtimeWorkspace.error}
          onLogout={auth.logout}
          onClose={closeSettings}
          onRefreshRuntime={() => void runtimeWorkspace.refresh()}
          onSetServiceEnabled={(enabled) => void runtimeWorkspace.setServiceEnabled(enabled)}
        /></Suspense>
      )}

      {/* Artifact side panel — the only on-demand right region; opens when the user opens an artifact */}
      {activeArtifact && (
        <Suspense fallback={null}><ArtifactPanel
          artifact={activeArtifact}
          onOpenArtifact={handleOpenArtifact}
          onOpenSession={handleSessionSelect}
          width={artifactDocked ? artifactPanelWidth : undefined}
          fullscreen={artifactFullscreen}
          docked={artifactDocked}
          onResize={handleArtifactResize}
          onResizeStart={handleArtifactResizeStart}
          onResizeEnd={handleArtifactResizeEnd}
          onFullscreenChange={setArtifactFullscreen}
          onClose={handleCloseArtifact}
        /></Suspense>
      )}
    </div>
  );
}
