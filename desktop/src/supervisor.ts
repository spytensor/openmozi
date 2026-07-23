import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { buildDesktopPath } from './environment.js';

export type RuntimeStatus = 'stopped' | 'starting' | 'ready' | 'stopping' | 'failed';

export interface DesktopRuntimeState {
  status: RuntimeStatus;
  owner: 'none' | 'external' | 'desktop';
  url: string;
  healthUrl: string;
  entryPath: string;
  nodePath: string;
  pythonPath?: string;
  moziHome: string;
  logPath: string;
  pid?: number;
  error?: string;
  checkedAt: string;
}

export interface RuntimePathOptions {
  appRoot: string;
  resourcesPath: string;
  userDataPath: string;
  isPackaged: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface RuntimePaths {
  runtimeRoot: string;
  entryPath: string;
  nodePath: string;
  pythonPath?: string;
  moziHome: string;
  logPath: string;
  host: string;
  browserHost: string;
  port: number;
  runtimeUrl: string;
  healthUrl: string;
}

export interface RuntimeSupervisorOptions {
  paths: RuntimePaths;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  now?: () => Date;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  forceKillTimeoutMs?: number;
}

const DEFAULT_PORT = 9210;
const DEFAULT_HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 800;
const AUTH_MODES = new Set(['token', 'none', 'oauth', 'saml', 'local']);

export function desktopManagedAuthOverride(moziHome: string, env: NodeJS.ProcessEnv): string | undefined {
  if (env.MOZI_SERVER_AUTH_MODE) return env.MOZI_SERVER_AUTH_MODE;
  try {
    const config = JSON.parse(readFileSync(join(moziHome, 'mozi.json'), 'utf8')) as { server?: { auth_mode?: unknown } };
    if (typeof config.server?.auth_mode === 'string' && AUTH_MODES.has(config.server.auth_mode)) return undefined;
  } catch {
    // A missing or unreadable config is handled by the runtime; desktop only supplies its safe local default.
  }
  return 'local';
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    return DEFAULT_PORT;
  }
  return parsed;
}

export function browserHostFor(host: string): string {
  return host === '0.0.0.0' || host === '::' ? DEFAULT_HOST : host;
}

export function resolveRuntimePaths(options: RuntimePathOptions): RuntimePaths {
  const env = options.env ?? process.env;
  const runtimeRoot = env.MOZI_RUNTIME_ROOT
    ? resolve(env.MOZI_RUNTIME_ROOT)
    : options.isPackaged
      ? join(options.resourcesPath, 'mozi')
      : resolve(options.appRoot, '..');
  const entryPath = env.MOZI_RUNTIME_ENTRY
    ? resolve(env.MOZI_RUNTIME_ENTRY)
    : join(runtimeRoot, 'dist', 'index.js');
  const nodePath = env.MOZI_NODE_BIN
    ? resolve(env.MOZI_NODE_BIN)
    : options.isPackaged
      ? join(options.resourcesPath, 'node', 'bin', 'node')
      : env.npm_node_execpath || process.execPath;
  const pythonPath = env.MOZI_PYTHON
    ? resolve(env.MOZI_PYTHON)
    : options.isPackaged
      ? join(options.resourcesPath, 'python', 'bin', 'python3')
      : undefined;
  const moziHome = env.MOZI_HOME || (options.isPackaged ? options.userDataPath : join(homedir(), '.mozi'));
  const logPath = env.MOZI_LOG_PATH || join(moziHome, 'logs', 'mozi.log');
  const host = env.MOZI_SERVER_HOST || DEFAULT_HOST;
  const browserHost = browserHostFor(host);
  const port = parsePort(env.MOZI_SERVER_PORT);
  const runtimeUrl = `http://${browserHost}:${port}/`;

  return {
    runtimeRoot,
    entryPath,
    nodePath,
    pythonPath,
    moziHome,
    logPath,
    host,
    browserHost,
    port,
    runtimeUrl,
    healthUrl: `${runtimeUrl}api/health`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MoziRuntimeSupervisor {
  private state: DesktopRuntimeState;
  private child: ChildProcess | null = null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  private readonly now: () => Date;
  private readonly startupTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly forceKillTimeoutMs: number;
  private healthIdentityError: string | undefined;

  constructor(options: RuntimeSupervisorOptions) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.now = options.now ?? (() => new Date());
    this.startupTimeoutMs = options.startupTimeoutMs ?? 12_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 300;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? 10_000;
    this.forceKillTimeoutMs = options.forceKillTimeoutMs ?? 2_000;
    this.state = this.buildState('stopped', options.paths);
  }

  getState(): DesktopRuntimeState {
    return { ...this.state };
  }

  async ensureReady(): Promise<DesktopRuntimeState> {
    if (await this.isHealthy()) {
      this.state = {
        ...this.state,
        status: 'ready',
        owner: this.child && !this.child.killed ? 'desktop' : 'external',
        checkedAt: timestamp(this.now),
      };
      return this.getState();
    }
    if (this.healthIdentityError) {
      return this.fail(this.healthIdentityError);
    }

    const missing = this.firstMissingRuntimeFile();
    if (missing) {
      return this.fail(`${missing.label} not found at ${missing.path}`);
    }

    this.state = { ...this.state, status: 'starting', error: undefined, checkedAt: timestamp(this.now) };
    this.startRuntimeProcess();

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.startupTimeoutMs) {
      if (this.state.status === 'failed') {
        return this.getState();
      }
      if (await this.isHealthy()) {
        this.state = {
          ...this.state,
          status: 'ready',
          owner: 'desktop',
          pid: this.child?.pid ?? this.state.pid,
          checkedAt: timestamp(this.now),
        };
        return this.getState();
      }
      if (this.healthIdentityError) {
        const error = this.healthIdentityError;
        await this.stopOwnedProcess();
        return this.fail(error);
      }
      await sleep(this.pollIntervalMs);
    }

    await this.stopOwnedProcess();
    return this.fail(`MOZI runtime did not become healthy within ${this.startupTimeoutMs}ms`);
  }

  async stopOwnedProcess(): Promise<DesktopRuntimeState> {
    const child = this.child;
    if (!child) return this.getState();

    this.state = { ...this.state, status: 'stopping', checkedAt: timestamp(this.now) };
    child.kill('SIGTERM');
    if (!await this.waitForExit(child, this.shutdownTimeoutMs)) {
      child.kill('SIGKILL');
      if (!await this.waitForExit(child, this.forceKillTimeoutMs)) {
        return this.fail(`MOZI runtime PID ${child.pid ?? 'unknown'} did not exit after SIGTERM and SIGKILL`);
      }
    }

    if (this.child === child) this.child = null;
    this.state = {
      ...this.state,
      status: 'stopped',
      owner: 'none',
      pid: undefined,
      error: undefined,
      checkedAt: timestamp(this.now),
    };
    return this.getState();
  }

  private buildState(status: RuntimeStatus, paths: RuntimePaths): DesktopRuntimeState {
    return {
      status,
      owner: 'none',
      url: paths.runtimeUrl,
      healthUrl: paths.healthUrl,
      entryPath: paths.entryPath,
      nodePath: paths.nodePath,
      pythonPath: paths.pythonPath,
      moziHome: paths.moziHome,
      logPath: paths.logPath,
      checkedAt: timestamp(this.now),
    };
  }

  private firstMissingRuntimeFile(): { label: string; path: string } | null {
    if (!existsSync(this.state.entryPath)) {
      return { label: 'MOZI runtime entrypoint', path: this.state.entryPath };
    }
    if (!existsSync(this.state.nodePath)) {
      return { label: 'Bundled Node runtime', path: this.state.nodePath };
    }
    if (this.state.pythonPath && !existsSync(this.state.pythonPath)) {
      return { label: 'Managed Python document runtime', path: this.state.pythonPath };
    }
    return null;
  }

  private async isHealthy(): Promise<boolean> {
    this.healthIdentityError = undefined;
    try {
      const response = await this.fetchImpl(this.state.healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const payload = await response.json() as { ok?: unknown; pid?: unknown; mozi_home?: unknown };
      if (payload.ok !== true) return false;
      if (typeof payload.mozi_home !== 'string') {
        this.healthIdentityError = `MOZI runtime at ${this.state.healthUrl} did not report mozi_home. Stop that runtime or upgrade it before launching the desktop app.`;
        return false;
      }
      const actualHome = resolve(payload.mozi_home);
      const expectedHome = resolve(this.state.moziHome);
      if (actualHome !== expectedHome) {
        this.healthIdentityError = `MOZI runtime at ${this.state.healthUrl} is using MOZI_HOME ${payload.mozi_home}, expected ${this.state.moziHome}. Stop that runtime or configure the desktop app with the same MOZI_HOME.`;
        return false;
      }
      if (typeof payload.pid === 'number') {
        this.state = { ...this.state, pid: payload.pid };
      }
      return true;
    } catch {
      return false;
    }
  }

  private startRuntimeProcess(): void {
    mkdirSync(dirname(this.state.logPath), { recursive: true, mode: 0o700 });
    const outFd = openSync(this.state.logPath, 'a');
    const authModeOverride = desktopManagedAuthOverride(this.state.moziHome, this.env);
    const managedPythonPath = this.state.pythonPath;
    const desktopPath = buildDesktopPath(this.env.PATH);
    const env = {
      ...this.env,
      NODE_ENV: 'production',
      MOZI_DESKTOP: '1',
      MOZI_BUILD_SURFACE: 'desktop',
      MOZI_DESKTOP_MANAGED_HOME: this.env.MOZI_HOME ? '0' : '1',
      MOZI_HOME: this.state.moziHome,
      MOZI_SERVER_HOST: DEFAULT_HOST,
      MOZI_SERVER_PORT: String(new URL(this.state.url).port || DEFAULT_PORT),
      ...(authModeOverride ? { MOZI_SERVER_AUTH_MODE: authModeOverride } : {}),
      ...(managedPythonPath ? { MOZI_PYTHON: managedPythonPath, PYTHONNOUSERSITE: '1' } : {}),
      PATH: [managedPythonPath ? dirname(managedPythonPath) : '', desktopPath].filter(Boolean).join(delimiter),
    };

    try {
      const child = this.spawnImpl(this.state.nodePath, [this.state.entryPath], {
        cwd: dirname(dirname(this.state.entryPath)),
        env,
        detached: false,
        stdio: ['ignore', outFd, outFd],
      });
      this.child = child;
      if (child.pid) {
        this.state = { ...this.state, owner: 'desktop', pid: child.pid };
      }
      child.once('error', (err) => {
        this.state = {
          ...this.state,
          status: 'failed',
          owner: 'desktop',
          error: `MOZI runtime failed to start: ${err.message}`,
          checkedAt: timestamp(this.now),
        };
      });
      child.once('exit', (code, signal) => {
        if (this.child === child) this.child = null;
        if (this.state.status === 'ready' || this.state.status === 'starting') {
          this.state = {
            ...this.state,
            status: 'failed',
            owner: 'desktop',
            error: `MOZI runtime exited with code ${code ?? 'null'} signal ${signal ?? 'null'}`,
            checkedAt: timestamp(this.now),
          };
        }
      });
    } finally {
      closeSync(outFd);
    }
  }

  private async waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode != null || child.signalCode != null) return true;
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      child.once('exit', onExit);
    });
  }

  private fail(error: string): DesktopRuntimeState {
    this.state = { ...this.state, status: 'failed', error, checkedAt: timestamp(this.now) };
    return this.getState();
  }
}
