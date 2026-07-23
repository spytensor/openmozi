import {
  CalendarClock,
  Circle,
  Command,
  FolderOpen,
  MessageSquarePlus,
  MoreHorizontal,
  LogOut,
  Loader2,
  PanelLeftClose,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import type { AppView, Session } from "@/types";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import { pathLeaf, runtimeRootLabel } from "@/lib/runtime-display";
import { useLocale } from "@/i18n";
import { useApi } from "@/hooks/useApi";
import MoziAvatar from "@/components/MoziAvatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type WorkspaceNavKey = "chats" | "projects" | "scheduled" | "skills" | "memory" | "files" | "settings" | "admin";

interface WorkspaceSidebarProps {
  active: WorkspaceNavKey;
  sessions: Session[];
  activeSessionId: string | null;
  projectsEnabled?: boolean;
  roots?: RuntimeWorkspaceRoot[];
  runtimeLoading?: boolean;
  isAdmin?: boolean;
  selectedRootId?: string | null;
  /** Collapsed = zero-width rail; the app shell owns the state (⌘B + reopen button). */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNavChange: (nav: WorkspaceNavKey) => void;
  onViewChange: (view: AppView) => void;
  onSelectSession: (id: string) => void;
  onSelectRoot: (root: RuntimeWorkspaceRoot | null) => void;
  onCreateSession: () => void;
  /** Start a new chat scoped to a project (from the project group header). */
  onNewProjectSession?: (rootId: string, label: string) => void;
  onDeleteSession?: (id: string) => void;
  onLogout?: () => void;
}

interface CurrentUser {
  name?: string | null;
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  avatarUrl?: string | null;
  workspace_label?: string | null;
  workspace?: {
    label?: string | null;
    name?: string | null;
  } | null;
}

interface ProjectSessionGroup {
  id: string;
  label: string;
  sessions: Session[];
  generic: boolean;
}

type TimeBucket = "today" | "yesterday" | "earlier";

function matchesQuery(value: string | undefined, query: string): boolean {
  if (!query) return true;
  return (value ?? "").toLowerCase().includes(query);
}

function isUnusedDraftSession(session: Session): boolean {
  const title = session.title ?? "New Chat";
  return (title === "New Chat" || title === "New chat") && session.message_count === 0;
}

function sessionTimestamp(session: Session): string | undefined {
  return session.updated_at || session.created_at;
}

function sessionProjectRootId(session: Session): string | null {
  if ("project_root_id" in session || "project_context" in session) {
    return session.project_root_id || session.project_context?.rootPath || null;
  }
  return session.workspace_root_id || session.workspace_context?.rootPath || null;
}

function sessionProjectContext(session: Session) {
  return ("project_context" in session ? session.project_context : session.workspace_context) ?? null;
}

function sortByRecent(a: Session, b: Session): number {
  const aTime = Date.parse(sessionTimestamp(a) ?? "");
  const bTime = Date.parse(sessionTimestamp(b) ?? "");
  return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function timeBucketForSession(session: Session, now = new Date()): TimeBucket {
  const timestamp = Date.parse(sessionTimestamp(session) ?? "");
  if (!Number.isFinite(timestamp)) return "earlier";
  const day = startOfLocalDay(new Date(timestamp));
  const today = startOfLocalDay(now);
  if (day === today) return "today";
  if (day === today - 24 * 60 * 60 * 1000) return "yesterday";
  return "earlier";
}

function normalizeCurrentUser(payload: unknown): CurrentUser | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const user = record.user && typeof record.user === "object" ? record.user : record;
  return user as CurrentUser;
}

function initialsFromName(name: string | null | undefined): string | null {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function workspaceLabelFromUser(user: CurrentUser | null): string | null {
  return user?.workspace_label
    || user?.workspace?.label
    || user?.workspace?.name
    || null;
}

export default function WorkspaceSidebar({
  active,
  sessions,
  activeSessionId,
  projectsEnabled = true,
  roots = [],
  runtimeLoading = false,
  isAdmin = false,
  collapsed = false,
  onToggleCollapse,
  onNavChange,
  onViewChange,
  onSelectSession,
  onCreateSession,
  onNewProjectSession,
  onDeleteSession,
  onLogout,
}: WorkspaceSidebarProps) {
  const { formatRelativeTime, locale, t } = useLocale();
  const { get } = useApi();
  const [search, setSearch] = useState("");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const query = search.trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setAccountLoading(true);
    get<unknown>("/api/users/me").then(({ data }) => {
      if (cancelled) return;
      setCurrentUser(normalizeCurrentUser(data));
      setAccountLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [get]);

  const rootById = useMemo(() => new Map(roots.map((root) => [root.id, root])), [roots]);
  const visibleSessions = useMemo(
    () => sessions.filter((session) => !isUnusedDraftSession(session)).sort(sortByRecent),
    [sessions],
  );

  const projectGroups = useMemo<ProjectSessionGroup[]>(() => {
    if (!projectsEnabled) return [];
    const known = new Map<string, Session[]>();
    const unknown = new Map<string, { label: string; sessions: Session[] }>();
    for (const session of visibleSessions) {
      const rootId = sessionProjectRootId(session);
      if (!rootId) continue;
      if (rootById.has(rootId)) {
        const bucket = known.get(rootId) ?? [];
        bucket.push(session);
        known.set(rootId, bucket);
      } else {
        const context = sessionProjectContext(session);
        const label = context?.label?.trim()
          || pathLeaf(context?.rootPath || rootId)
          || t("sidebar.projects");
        const bucket = unknown.get(rootId) ?? { label, sessions: [] };
        bucket.sessions.push(session);
        unknown.set(rootId, bucket);
      }
    }

    const groups = [...known.entries()].map(([rootId, groupSessions]) => ({
      id: rootId,
      label: runtimeRootLabel(rootById.get(rootId) as RuntimeWorkspaceRoot, locale),
      sessions: groupSessions,
      generic: false,
    }));
    for (const [rootId, group] of unknown.entries()) {
      groups.push({
        id: rootId,
        label: group.label,
        sessions: group.sessions,
        generic: false,
      });
    }
    return groups;
  }, [locale, projectsEnabled, rootById, t, visibleSessions]);

  const ungroupedSessions = useMemo(
    () => visibleSessions.filter((session) => !sessionProjectRootId(session) || !projectsEnabled),
    [projectsEnabled, visibleSessions],
  );

  const sessionMatches = (session: Session) => matchesQuery(session.title || t("sidebar.defaultChatTitle"), query);

  const filteredProjectGroups = useMemo(() => {
    return projectGroups
      .map((group) => {
        const groupMatches = matchesQuery(group.label, query);
        return {
          ...group,
          sessions: groupMatches ? group.sessions : group.sessions.filter(sessionMatches),
        };
      })
      .filter((group) => group.sessions.length > 0);
  }, [projectGroups, query, t]);

  const timeGroups = useMemo(() => {
    const buckets: Record<TimeBucket, Session[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const session of ungroupedSessions) {
      buckets[timeBucketForSession(session)].push(session);
    }
    return buckets;
  }, [ungroupedSessions]);

  const filteredTimeGroups = useMemo(() => {
    const labels: Record<TimeBucket, string> = {
      today: t("sidebar.today"),
      yesterday: t("sidebar.yesterday"),
      earlier: t("sidebar.earlier"),
    };
    return (Object.keys(timeGroups) as TimeBucket[]).map((bucket) => {
      const groupMatches = matchesQuery(labels[bucket], query);
      return {
        bucket,
        label: labels[bucket],
        sessions: groupMatches ? timeGroups[bucket] : timeGroups[bucket].filter(sessionMatches),
      };
    });
  }, [query, t, timeGroups]);

  const sessionCount = visibleSessions.length;
  const filteredSessionCount =
    filteredProjectGroups.reduce((count, group) => count + group.sessions.length, 0) +
    filteredTimeGroups.reduce((count, group) => count + group.sessions.length, 0);

  const handleNewChat = () => {
    onNavChange("chats");
    onViewChange("chat");
    onCreateSession();
  };

  const handleScheduled = () => {
    onNavChange("scheduled");
    onViewChange("scheduled");
  };

  const handleSkills = () => {
    onNavChange("skills");
    onViewChange("skills");
  };

  const handleFiles = () => {
    onNavChange("files");
    onViewChange("files");
  };

  const handleAdmin = () => {
    onNavChange("admin");
    onViewChange("admin");
  };

  const handleSettings = () => {
    onNavChange("settings");
    onViewChange("settings");
  };

  const handleSessionSelect = (id: string) => {
    onNavChange("chats");
    onViewChange("chat");
    onSelectSession(id);
  };

  return (
    <aside
      data-testid="workspace-sidebar"
      aria-hidden={collapsed}
      className="hidden h-full min-h-0 flex-shrink-0 overflow-hidden transition-[width] duration-200 md:flex"
      style={{
        width: collapsed ? 0 : 248,
        background: "var(--sidebar-bg)",
        borderRight: collapsed ? "none" : "1px solid var(--border-subtle)",
      }}
    >
      {/* Fixed-width inner column so content doesn't reflow mid-animation. */}
      <div className="flex h-full min-h-0 w-[248px] flex-shrink-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-3 px-3 pt-4">
        <div data-testid="sidebar-window-drag-region" className="desktop-window-drag-region flex h-8 items-center gap-2 px-1.5">
          <MoziAvatar size={24} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-normal text-ink/82">{t("sidebar.brand")}</span>
          {onToggleCollapse && (
            <button
              type="button"
              data-testid="sidebar-collapse"
              aria-label={t("sidebar.collapse")}
              title={`${t("sidebar.collapse")} (⌘B)`}
              onClick={onToggleCollapse}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/38 transition-colors hover:bg-ink/[0.06] hover:text-ink/75"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <nav className="flex flex-col gap-1">
          <TopNavItem
            icon={MessageSquarePlus}
            label={t("sidebar.newChat")}
            shortcut="⌘N"
            active={active === "chats"}
            onClick={handleNewChat}
            testId="new-chat-command"
          />
          <TopNavItem
            icon={CalendarClock}
            label={t("sidebar.scheduled")}
            active={active === "scheduled"}
            onClick={handleScheduled}
          />
          <TopNavItem
            icon={Sparkles}
            label={t("sidebar.skills")}
            active={active === "skills"}
            onClick={handleSkills}
          />
          <TopNavItem
            icon={FolderOpen}
            label={t("nav.files")}
            active={active === "files"}
            onClick={handleFiles}
          />
        </nav>

        <label
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5"
          style={{
            // The sidebar itself now shares --surface-input, so the search
            // field needs its own step: a quiet ink overlay reads as inset
            // on both themes without minting a new token.
            background: "rgb(var(--ink-rgb) / 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.03)",
            boxShadow: "inset 0 1px 3px rgba(0, 0, 0, 0.3), 0 1px 0 rgba(255, 255, 255, 0.02)",
          }}
        >
          <Search className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
          <input
            data-testid="sidebar-search-input"
            type="search"
            name="sidebar-search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            // Stop browsers / password managers from autofilling the account
            // email into this search box.
            data-1p-ignore
            data-lpignore="true"
            data-form-type="other"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("sidebar.search")}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-ink/30 [&::-webkit-search-cancel-button]:appearance-none"
            style={{ color: "var(--text-primary)" }}
          />
          <span className="flex items-center gap-0.5 text-[10.5px]" style={{ color: "var(--text-disabled)" }}>
            <Command className="h-3 w-3" />K
          </span>
        </label>
      </div>

      <div data-testid="sidebar-scroll-region" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-4">
        {/* Projects need no section header: each group carries a folder icon,
            name, and indented nesting, which already reads as "a project, not a
            plain chat". A "PROJECTS" label on top of that was triple-labeling.
            Project groups sit pinned at the top; the icon-less time groups
            (Today/Yesterday) below are visibly plain chats by contrast. */}
        {projectsEnabled && filteredProjectGroups.length > 0 && (
          <section className="mb-3 flex flex-col gap-1.5">
            {filteredProjectGroups.map((group) => (
              <div key={group.id} className="space-y-0.5">
                {!group.generic && (
                  <div className="group/proj flex items-center gap-1.5 px-2.5 pb-0.5 pt-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink/34">
                    <FolderOpen className="h-3 w-3 shrink-0 opacity-70" />
                    <span className="min-w-0 flex-1 truncate">{group.label}</span>
                    {onNewProjectSession && (
                      <button
                        type="button"
                        aria-label={t("sidebar.newProjectSession")}
                        title={t("sidebar.newProjectSession")}
                        onClick={() => onNewProjectSession(group.id, group.label)}
                        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink/40 opacity-0 transition-opacity hover:bg-ink/[0.08] hover:text-ink/75 focus:opacity-100 group-hover/proj:opacity-100"
                      >
                        <MessageSquarePlus className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                )}
                <div className={!group.generic ? "ml-3 space-y-0.5 border-l border-ink/[0.08] pl-1" : "space-y-0.5"}>
                  {group.sessions.map((session) => (
                    <SessionLeaf
                      key={session.id}
                      id={session.id}
                      active={session.id === activeSessionId}
                      label={session.title || t("sidebar.defaultChatTitle")}
                      meta={sessionTimestamp(session) ? formatRelativeTime(sessionTimestamp(session) as string) : undefined}
                      activity={session.activity_status}
                      runningLabel={t("sidebar.sessionRunning")}
                      awaitingLabel={t("sidebar.sessionAwaitingApproval")}
                      actionLabel={t("sidebar.sessionActions")}
                      deleteLabel={t("sidebar.deleteSession")}
                      onClick={() => handleSessionSelect(session.id)}
                      onDelete={onDeleteSession ? () => onDeleteSession(session.id) : undefined}
                    />
                  ))}
                </div>
              </div>
            ))}
          </section>
        )}

        {sessionCount === 0 ? (
          <SessionSection label={t("sidebar.today")}>
            <EmptyRow label={t("sidebar.noChatsYet")} />
          </SessionSection>
        ) : filteredSessionCount === 0 ? (
          <SessionSection label={t("sidebar.today")}>
            <EmptyRow label={t("sidebar.noChatsFound")} />
          </SessionSection>
        ) : (
          filteredTimeGroups.map((group) => (
            group.sessions.length > 0 && (
              <SessionSection key={group.bucket} label={group.label}>
                {group.sessions.map((session) => (
                  <SessionLeaf
                    key={session.id}
                    id={session.id}
                    active={session.id === activeSessionId}
                    label={session.title || t("sidebar.defaultChatTitle")}
                    meta={sessionTimestamp(session) ? formatRelativeTime(sessionTimestamp(session) as string) : undefined}
                    activity={session.activity_status}
                    runningLabel={t("sidebar.sessionRunning")}
                    awaitingLabel={t("sidebar.sessionAwaitingApproval")}
                    actionLabel={t("sidebar.sessionActions")}
                    deleteLabel={t("sidebar.deleteSession")}
                    onClick={() => handleSessionSelect(session.id)}
                    onDelete={onDeleteSession ? () => onDeleteSession(session.id) : undefined}
                  />
                ))}
              </SessionSection>
            )
          ))
        )}
      </div>

      <AccountRow
        user={currentUser}
        loading={accountLoading}
        userAvatarLabel={t("sidebar.userAvatar")}
        loadingLabel={t("common.loading")}
        unavailableLabel={t("sidebar.accountUnavailable")}
        workspaceUnavailableLabel={t("sidebar.workspaceUnavailable")}
        settingsLabel={t("sidebar.accountSettings")}
        logoutLabel={t("sidebar.logout")}
        accountMenuLabel={t("sidebar.accountMenu")}
        active={active === "settings" || active === "admin"}
        isAdmin={isAdmin}
        adminLabel={t("sidebar.admin")}
        adminActive={active === "admin"}
        onAdmin={handleAdmin}
        onSettings={handleSettings}
        onLogout={onLogout}
      />
      </div>
    </aside>
  );
}

function TopNavItem({
  icon: Icon,
  label,
  shortcut,
  active,
  onClick,
  testId,
}: {
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  label: string;
  shortcut?: string;
  active?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      data-testid={testId}
      onClick={onClick}
      className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-all duration-200 hover:bg-ink/[0.04] active:scale-[0.98]"
      style={{
        background: active ? "var(--surface-active)" : "transparent",
        color: active ? "var(--text-primary)" : "rgb(var(--ink-rgb) / 0.62)",
      }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-85" />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{label}</span>
      {shortcut && <span className="text-[10.5px] text-ink/28">{shortcut}</span>}
    </button>
  );
}

function SessionSection({
  icon: Icon,
  label,
  children,
}: {
  icon?: ComponentType<{ className?: string; style?: CSSProperties }>;
  label: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-3">
      <div className="mb-1 flex items-center gap-2 px-2 py-1 text-[11px] font-semibold uppercase text-ink/34">
        {Icon && <Icon className="h-3.5 w-3.5 opacity-70" />}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </section>
  );
}

function SessionLeaf({
  id,
  label,
  meta,
  activity,
  runningLabel,
  awaitingLabel,
  active,
  actionLabel,
  deleteLabel,
  onClick,
  onDelete,
}: {
  id: string;
  label: string;
  meta?: string;
  activity?: Session["activity_status"];
  runningLabel: string;
  awaitingLabel: string;
  active?: boolean;
  actionLabel: string;
  deleteLabel: string;
  onClick: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      data-sidebar-row-kind="chat"
      data-session-id={id}
      className="group relative flex items-center rounded-md transition-all duration-200 hover:bg-ink/[0.04] active:scale-[0.98]"
      style={{
        background: active ? "var(--surface-active)" : "transparent",
      }}
    >
      {active && <span className="absolute left-0 top-1.5 h-5 w-[3px] rounded-r-full" style={{ background: "var(--nav-active-indicator)" }} />}
      <button
        onClick={onClick}
        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2.5 pr-1 text-left"
        style={{ color: active ? "rgb(var(--ink-rgb) / 0.92)" : "rgb(var(--ink-rgb) / 0.58)" }}
      >
        <span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
        {activity === "running" ? (
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-activity/80" title={runningLabel} aria-label={runningLabel}>
            <Loader2 data-testid={`session-activity-running-${id}`} className="h-3 w-3 animate-spin" />
          </span>
        ) : activity === "awaiting_approval" ? (
          <span className="flex max-w-[76px] shrink-0 items-center gap-1 truncate text-[10.5px] text-amber-500/90" title={awaitingLabel} aria-label={awaitingLabel}>
            <Circle className="h-2.5 w-2.5 fill-current" />
            <span className="truncate">{awaitingLabel}</span>
          </span>
        ) : meta ? <span className="max-w-[58px] shrink-0 truncate text-[10.5px] text-ink/28">{meta}</span> : null}
      </button>
      {onDelete && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={actionLabel}
              className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink/36 opacity-0 transition-opacity hover:bg-ink/[0.06] hover:text-ink/75 focus:opacity-100 group-hover:opacity-100"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="right"
            align="start"
            className="w-[156px] rounded-lg border border-ink/[0.08] bg-elevated p-1 text-ink shadow-2xl"
          >
            <DropdownMenuItem
              className="gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-danger focus:bg-danger/10 focus:text-danger"
              onSelect={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function AccountRow({
  user,
  loading,
  userAvatarLabel,
  loadingLabel,
  unavailableLabel,
  workspaceUnavailableLabel,
  settingsLabel,
  logoutLabel,
  accountMenuLabel,
  active,
  isAdmin = false,
  adminLabel,
  adminActive = false,
  onAdmin,
  onSettings,
  onLogout,
}: {
  user: CurrentUser | null;
  loading: boolean;
  userAvatarLabel: string;
  loadingLabel: string;
  unavailableLabel: string;
  workspaceUnavailableLabel: string;
  settingsLabel: string;
  logoutLabel: string;
  accountMenuLabel: string;
  active: boolean;
  isAdmin?: boolean;
  adminLabel?: string;
  adminActive?: boolean;
  onAdmin?: () => void;
  onSettings: () => void;
  onLogout?: () => void;
}) {
  const name = user?.name || user?.display_name || user?.email || null;
  const avatarUrl = user?.avatar_url || user?.avatarUrl || null;
  const initials = initialsFromName(user?.name || user?.display_name);
  const workspaceLabel = workspaceLabelFromUser(user);

  const displayName = loading ? loadingLabel : name ?? unavailableLabel;
  const displayWorkspace = loading ? loadingLabel : workspaceLabel ?? workspaceUnavailableLabel;

  return (
    <div className="shrink-0 border-t border-ink/[0.06] px-2 py-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="account-row"
            aria-label={accountMenuLabel}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink/[0.05]"
            style={{ background: active ? "var(--surface-active)" : undefined }}
          >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-ink/[0.07] text-[11px] font-semibold text-ink/76">
              {avatarUrl ? (
                <img src={avatarUrl} alt={userAvatarLabel} className="h-full w-full object-cover" />
              ) : initials ? (
                initials
              ) : (
                <UserRound className="h-3.5 w-3.5 text-ink/46" />
              )}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[12.5px] font-medium text-ink/82">{displayName}</span>
              <span className="block truncate text-[10.5px] text-ink/38">{displayWorkspace}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[228px] rounded-lg border border-ink/[0.10] bg-elevated p-1 text-ink shadow-[0_24px_70px_-28px_rgba(0,0,0,0.72)]"
        >
          {/* Identity header — informational, not clickable */}
          <div className="px-2.5 pb-1.5 pt-2">
            <p className="truncate text-[12.5px] font-medium text-ink/82">{displayName}</p>
            {user?.email && user.email !== name && (
              <p className="truncate text-[11px] text-ink/40">{user.email}</p>
            )}
            <p className="truncate text-[10.5px] text-ink/34">{displayWorkspace}</p>
          </div>
          <DropdownMenuSeparator className="my-1 bg-ink/[0.06]" />
          <DropdownMenuItem
            onSelect={onSettings}
            className="mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] text-ink/78 focus:bg-ink/[0.06] focus:text-ink"
          >
            <Settings className="h-3.5 w-3.5 text-ink/44" />
            {settingsLabel}
          </DropdownMenuItem>
          {isAdmin && onAdmin && (
            <DropdownMenuItem
              data-testid="account-admin"
              onSelect={onAdmin}
              className="mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] text-ink/78 focus:bg-ink/[0.06] focus:text-ink"
              style={{ background: adminActive ? "var(--surface-active)" : undefined }}
            >
              <ShieldCheck className="h-3.5 w-3.5 text-ink/44" />
              {adminLabel}
            </DropdownMenuItem>
          )}
          {onLogout && (
            <>
              <DropdownMenuSeparator className="my-1 bg-ink/[0.06]" />
              <DropdownMenuItem
                data-testid="account-logout"
                onSelect={onLogout}
                className="mx-1 flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[12.5px] text-ink/78 focus:bg-ink/[0.06] focus:text-ink"
              >
                <LogOut className="h-3.5 w-3.5 text-ink/44" />
                {logoutLabel}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px]" style={{ color: "var(--text-muted)" }}>
      <Circle className="h-2.5 w-2.5 opacity-50" />
      {label}
    </div>
  );
}
