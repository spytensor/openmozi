import { screen, renderWithLocale } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeHealth, RuntimeLogSnapshot, RuntimeServiceStatus, RuntimeWorkspaceSnapshot } from "@/types/runtime";
import RuntimeInspectView from "./RuntimeInspectView";

const longPath = "/Users/test/.mozi/workspace/projects/very-long-project-name-that-should-not-force-horizontal-scroll";

const snapshot: RuntimeWorkspaceSnapshot = {
  generated_at: "2026-07-01T00:00:00.000Z",
  mozi_home: { path: "/Users/test/.mozi", exists: true },
  config: {
    path: "/Users/test/.mozi/mozi.json",
    exists: true,
    server: { host: "127.0.0.1", port: 9210, auth_mode: "none" },
    workspace_dir: "/Users/test/.mozi/workspace",
    workspace_dir_resolved: "/Users/test/.mozi/workspace",
  },
  storage: {
    db_path: "/Users/test/.mozi/data/mozi.db",
    db_exists: true,
    db_size_bytes: 4096,
    log_path: "/Users/test/.mozi/logs/mozi.log",
    log_exists: true,
    log_size_bytes: 2048,
    heartbeat_path: "/Users/test/.mozi/data/heartbeat.json",
    heartbeat_exists: true,
    pid_path: "/Users/test/.mozi/data/mozi.pid",
    pid_exists: true,
  },
  migration: {
    legacy_home_path: "/Users/test/.mozi",
    legacy_home_exists: true,
    target_home_path: "/Users/test/Library/Application Support/MOZI",
    manifest_path: "/Users/test/.mozi/.mozi-desktop-migration.json",
    manifest_exists: true,
    conflict: false,
  },
  roots: [
    {
      id: "project",
      kind: "project_root",
      label: "Runtime Source",
      path: longPath,
      exists: true,
      git: { is_repo: true, branch: "codex/layout-polish" },
    },
  ],
  counts: {
    sessions: 2,
    conversations: 12,
    memory_facts: 4,
    session_digests: 1,
    skills: 7,
    active_tasks: 0,
    worker_jobs: 1,
    background_tasks: 0,
  },
  runtime: {
    tasks_by_status: { succeeded: 3 },
    worker_jobs_by_status: { running: 1 },
    background_tasks_by_status: {},
  },
};

const logs: RuntimeLogSnapshot = {
  path: "/Users/test/.mozi/logs/mozi.log",
  exists: true,
  size_bytes: 2048,
  truncated: false,
  lines: ["runtime ready"],
};

const service: RuntimeServiceStatus = {
  installed: true,
  platform: "darwin",
  unitPath: "/Users/test/Library/LaunchAgents/com.mozi.plist",
  active: true,
  enabled: true,
};

const health: RuntimeHealth = {
  ok: true,
  pid: 12345,
  mozi_home: "/Users/test/.mozi",
  config_path: "/Users/test/.mozi/mozi.json",
};

describe("RuntimeInspectView", () => {
  it("uses a bounded workspace page and responsive diagnostic layout", () => {
    renderWithLocale(
      <RuntimeInspectView
        snapshot={snapshot}
        logs={logs}
        health={health}
        service={service}
        loading={false}
        serviceBusy={false}
        error={null}
        onRefresh={vi.fn()}
        onSetServiceEnabled={vi.fn()}
      />,
    );

    const region = screen.getByTestId("inspect-scroll-region");
    expect(region).toHaveClass("overflow-y-auto", "overflow-x-hidden", "p-4");
    expect(region.firstElementChild).toHaveClass("min-w-0");
    expect(region.querySelectorAll(".card-surface").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Runtime Health")).toBeInTheDocument();
    expect(screen.getByText("Responding now")).toBeInTheDocument();
    expect(screen.getByText("Workspace Roots")).toBeInTheDocument();
    expect(screen.queryByText("Log Tail")).not.toBeInTheDocument();
    expect(screen.getByText("Advanced Diagnostics")).toBeInTheDocument();
  });
});
