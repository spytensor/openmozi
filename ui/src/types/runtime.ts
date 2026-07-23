export type RuntimeRootKind = "mozi_home" | "workspace" | "allowed_root" | "project_root" | "output";

export interface RuntimeWorkspaceRoot {
  id: string;
  kind: RuntimeRootKind;
  label: string;
  path: string;
  exists: boolean;
  /** Whether `/api/fs/list` can serve this root. Files scopes filter on it. */
  browsable?: boolean;
  git?: {
    is_repo: boolean;
    branch?: string;
    /** Short SHA when HEAD is detached (no branch). */
    detached_sha?: string;
  };
}

export interface RuntimeWorkspaceSnapshot {
  generated_at: string;
  mozi_home: {
    path: string;
    exists: boolean;
  };
  config: {
    path: string;
    exists: boolean;
    server: {
      host?: string;
      port?: number;
      auth_mode?: string;
    };
    workspace_dir: string;
    workspace_dir_resolved: string;
  };
  storage: {
    db_path: string;
    db_exists: boolean;
    db_size_bytes: number;
    log_path: string;
    log_exists: boolean;
    log_size_bytes: number;
    heartbeat_path: string;
    heartbeat_exists: boolean;
    pid_path: string;
    pid_exists: boolean;
  };
  migration: {
    legacy_home_path: string;
    legacy_home_exists: boolean;
    target_home_path: string;
    manifest_path: string;
    manifest_exists: boolean;
    conflict: boolean;
  };
  roots: RuntimeWorkspaceRoot[];
  counts: {
    sessions: number;
    conversations: number;
    memory_facts: number;
    session_digests: number;
    skills: number;
    active_tasks: number;
    worker_jobs: number;
    background_tasks: number;
  };
  runtime: {
    tasks_by_status: Record<string, number>;
    worker_jobs_by_status: Record<string, number>;
    background_tasks_by_status: Record<string, number>;
  };
}

export interface RuntimeLogSnapshot {
  path: string;
  exists: boolean;
  size_bytes: number;
  truncated: boolean;
  lines: string[];
}

export interface RuntimeHealth {
  ok: boolean;
  pid: number;
  mozi_home: string;
  config_path: string;
  version?: string;
  commit?: string;
  surface?: BuildSurface;
}

export type BuildSurface = "desktop" | "docker" | "source";
export type ReleaseChannel = "stable" | "beta" | "dev";

export interface RuntimeBuildInfo {
  version: string;
  commit: string;
  buildTime: string;
  channel: ReleaseChannel;
  surface: BuildSurface;
}

export type RuntimeServicePlatform = "linux" | "darwin" | "unsupported";

export type RuntimeServiceStatus =
  | {
      installed: false;
      platform: RuntimeServicePlatform;
    }
  | {
      installed: true;
      platform: RuntimeServicePlatform;
      unitPath: string;
      active: boolean;
      enabled: boolean;
    };

export interface RuntimeServiceActionResponse {
  ok: boolean;
  action: "enable" | "disable";
  status: RuntimeServiceStatus;
  error?: string;
}

export interface WorkspaceMessageContext {
  rootPath: string;
  rootKind: RuntimeRootKind;
  label: string;
  gitBranch?: string;
}
