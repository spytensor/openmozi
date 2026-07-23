import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/types";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import WorkspaceSidebar, { type WorkspaceNavKey } from "./WorkspaceSidebar";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    get: apiMocks.get,
  }),
}));

const now = Date.now();
const todayIso = new Date(now).toISOString();
const yesterdayIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
const earlierIso = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

const sessions: Session[] = [
  {
    id: "sess-1",
    title: "OpenClaw research",
    updated_at: todayIso,
    message_count: 2,
  },
  {
    id: "sess-2",
    title: "Yesterday plan",
    updated_at: yesterdayIso,
    message_count: 1,
  },
  {
    id: "sess-3",
    title: "Project implementation",
    updated_at: earlierIso,
    message_count: 6,
    workspace_root_id: "root-1",
  },
];

const roots: RuntimeWorkspaceRoot[] = [
  {
    id: "root-1",
    kind: "project_root",
    label: "Mozi",
    path: "/Users/test/Mozi",
    exists: true,
    git: { is_repo: true, branch: "main" },
  },
];

function renderSidebar(overrides: Partial<ComponentProps<typeof WorkspaceSidebar>> = {}) {
  const props: ComponentProps<typeof WorkspaceSidebar> = {
    active: "chats",
    sessions,
    activeSessionId: "sess-1",
    roots,
    onNavChange: vi.fn(),
    onViewChange: vi.fn(),
    onSelectSession: vi.fn(),
    onSelectRoot: vi.fn(),
    onCreateSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };

  const rendered = renderWithLocale(<WorkspaceSidebar {...props} />);
  return { ...props, container: rendered.container };
}

describe("WorkspaceSidebar", () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.get.mockReturnValue(new Promise(() => {}));
  });

  it("renders the brand row and quiet top workbench actions", () => {
    const props = renderSidebar({ active: "projects" as WorkspaceNavKey });

    expect(screen.getByTestId("mozi-avatar")).toBeInTheDocument();
    expect(screen.getByText("MOZI")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-window-drag-region")).toHaveClass("desktop-window-drag-region");
    expect(screen.getByTestId("new-chat-command")).toHaveTextContent("New chat");
    expect(screen.getByRole("button", { name: /Scheduled/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Skills/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("new-chat-command"));

    expect(props.onSelectRoot).not.toHaveBeenCalled();
    expect(props.onNavChange).toHaveBeenCalledWith("chats");
    expect(props.onViewChange).toHaveBeenCalledWith("chat");
    expect(props.onCreateSession).toHaveBeenCalledTimes(1);
  });

  it("groups project sessions under their folder header and ungrouped sessions by time", () => {
    const rendered = renderSidebar();

    // No redundant "PROJECTS" section header — the project's own folder header
    // (its name) is the only label, distinguishing it from plain time chats.
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.getByText("Mozi")).toBeInTheDocument();
    expect(screen.getByText("Project implementation")).toBeInTheDocument();
    expect(screen.getByText("Today")).toBeInTheDocument();
    expect(screen.getByText("Yesterday")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw research")).toBeInTheDocument();
    expect(screen.getByText("Yesterday plan")).toBeInTheDocument();
    expect(rendered.container.querySelector('[data-session-id="sess-1"]')).toHaveTextContent("OpenClaw research");
  });

  it("shows durable running and approval-needed states instead of stale timestamps", () => {
    renderSidebar({
      sessions: [
        { ...sessions[0], activity_status: "running" },
        { ...sessions[1], activity_status: "awaiting_approval" },
      ],
    });

    expect(screen.getByLabelText("Running")).toBeInTheDocument();
    expect(screen.getByLabelText("Approval needed")).toBeInTheDocument();
    expect(screen.getByTestId("session-activity-running-sess-1")).toHaveClass("animate-spin");
  });

  it("supports search across visible session groups", () => {
    const rendered = renderSidebar();

    fireEvent.change(screen.getByTestId("sidebar-search-input"), { target: { value: "openclaw" } });

    expect(screen.getByText("OpenClaw research")).toBeInTheDocument();
    expect(screen.queryByText("Yesterday plan")).not.toBeInTheDocument();
    expect(screen.queryByText("Project implementation")).not.toBeInTheDocument();
    expect(rendered.container.querySelectorAll('[data-sidebar-row-kind="chat"]')).toHaveLength(1);
  });

  it("hides unused New Chat drafts from session history", () => {
    const rendered = renderSidebar({
      sessions: [
        ...sessions,
        {
          id: "draft-empty",
          title: "New Chat",
          updated_at: todayIso,
          message_count: 0,
        },
      ],
    });

    expect(rendered.container.querySelector('[data-session-id="draft-empty"]')).not.toBeInTheDocument();
    expect(rendered.container.querySelectorAll('[data-sidebar-row-kind="chat"]')).toHaveLength(3);
  });

  it("renders a fallback project group header when runtime root labels are unavailable", () => {
    renderSidebar({
      roots: [],
      sessions: [
        {
          id: "project-session",
          title: "Unknown root work",
          updated_at: todayIso,
          message_count: 1,
          workspace_root_id: "missing-root",
        },
      ],
    });

    // Header falls back to the derived root leaf; the session still groups
    // under it as a project (with its own folder header), not a plain chat.
    expect(screen.getByText("missing-root")).toBeInTheDocument();
    expect(screen.getByText("Unknown root work")).toBeInTheDocument();
  });

  it("can hide project grouping when projects are disabled", () => {
    renderSidebar({ projectsEnabled: false });

    expect(screen.queryByText("Mozi")).not.toBeInTheDocument();
    expect(screen.getByText("Project implementation")).toBeInTheDocument();
  });

  it("routes scheduled and skills nav entries to main views", () => {
    const props = renderSidebar();

    fireEvent.click(screen.getByRole("button", { name: /Scheduled/i }));
    expect(props.onNavChange).toHaveBeenCalledWith("scheduled");
    expect(props.onViewChange).toHaveBeenCalledWith("scheduled");

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    expect(props.onNavChange).toHaveBeenCalledWith("skills");
    expect(props.onViewChange).toHaveBeenCalledWith("skills");
  });

  it("exposes admin from the account menu for admins only", async () => {
    const props = renderSidebar({ isAdmin: true, active: "admin" as WorkspaceNavKey });

    // Admin is no longer a top-nav item — it lives in the avatar dropdown.
    expect(screen.queryByRole("button", { name: "Admin" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("account-row"), { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Admin" }));
    expect(props.onNavChange).toHaveBeenCalledWith("admin");
    expect(props.onViewChange).toHaveBeenCalledWith("admin");
  });

  it("hides admin from the account menu for non-admins", async () => {
    renderSidebar({ isAdmin: false });

    fireEvent.keyDown(screen.getByTestId("account-row"), { key: "Enter", code: "Enter" });
    expect(await screen.findByRole("menuitem", { name: /Account settings/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Admin" })).not.toBeInTheDocument();
  });

  it("wires only the existing delete session action", async () => {
    const props = renderSidebar();
    const action = props.container.querySelector('[data-session-id="sess-1"] [aria-label="Session actions"]') as HTMLElement;

    fireEvent.keyDown(action, { key: "Enter", code: "Enter" });
    expect(screen.queryByRole("menuitem", { name: /Rename/i })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete session" }));

    expect(props.onDeleteSession).toHaveBeenCalledWith("sess-1");
  });

  it("renders account data from /api/users/me and routes the gear to settings", async () => {
    apiMocks.get.mockResolvedValue({
      data: {
        user: {
          name: "Ada Runtime",
          avatar_url: null,
          workspace_label: "Design Lab",
        },
      },
      error: null,
    });
    const props = renderSidebar();

    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/api/users/me"));
    expect(await screen.findByText("Ada Runtime")).toBeInTheDocument();
    expect(screen.getByText("Design Lab")).toBeInTheDocument();
    expect(screen.getByText("AR")).toBeInTheDocument();

    // Settings and Log out live inside the account menu now — a bare icon
    // was too easy to hit by accident.
    fireEvent.keyDown(screen.getByTestId("account-row"), { key: "Enter", code: "Enter" });
    fireEvent.click(await screen.findByText("Account settings"));

    expect(props.onNavChange).toHaveBeenCalledWith("settings");
    expect(props.onViewChange).toHaveBeenCalledWith("settings");
  });

  it("shows the collapse toggle only when the shell provides a handler", () => {
    renderSidebar();
    expect(screen.queryByTestId("sidebar-collapse")).not.toBeInTheDocument();

    const onToggleCollapse = vi.fn();
    renderSidebar({ onToggleCollapse });
    fireEvent.click(screen.getByTestId("sidebar-collapse"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("collapses to zero width and hides itself from the a11y tree", () => {
    const { container } = renderSidebar({ collapsed: true, onToggleCollapse: vi.fn() });
    const aside = container.querySelector("aside");
    expect(aside).toHaveAttribute("aria-hidden", "true");
    expect(aside).toHaveStyle({ width: "0px" });
  });
});
