import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  browserHostFor,
  desktopManagedAuthOverride,
  MoziRuntimeSupervisor,
  resolveRuntimePaths,
  type RuntimePaths,
} from './supervisor.js';

function makePaths(overrides: Partial<RuntimePaths> = {}): RuntimePaths {
  const root = mkdtempSync(join(tmpdir(), 'mozi-desktop-runtime-'));
  const entryPath = join(root, 'dist', 'index.js');
  const nodePath = join(root, 'node');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(entryPath, 'console.log("mozi")');
  writeFileSync(nodePath, '');
  return {
    runtimeRoot: root,
    entryPath,
    nodePath,
    moziHome: join(root, 'home'),
    logPath: join(root, 'home', 'logs', 'mozi.log'),
    host: '127.0.0.1',
    browserHost: '127.0.0.1',
    port: 9210,
    runtimeUrl: 'http://127.0.0.1:9210/',
    healthUrl: 'http://127.0.0.1:9210/api/health',
    ...overrides,
  };
}

function fetchResponse(ok: boolean, payload: unknown): Response {
  return {
    ok,
    json: async () => payload,
  } as Response;
}

describe('desktop runtime supervisor', () => {
  it('defaults an unconfigured desktop-owned runtime to usable local authentication', () => {
    const paths = makePaths();
    mkdirSync(paths.moziHome, { recursive: true });
    writeFileSync(join(paths.moziHome, 'mozi.json'), JSON.stringify({ brain: { model: 'test' } }));

    expect(desktopManagedAuthOverride(paths.moziHome, {})).toBe('local');
  });

  it('preserves explicit environment and config authentication modes', () => {
    const paths = makePaths();
    mkdirSync(paths.moziHome, { recursive: true });
    writeFileSync(join(paths.moziHome, 'mozi.json'), JSON.stringify({ server: { auth_mode: 'local' } }));

    expect(desktopManagedAuthOverride(paths.moziHome, {})).toBeUndefined();
    expect(desktopManagedAuthOverride(paths.moziHome, { MOZI_SERVER_AUTH_MODE: 'saml' })).toBe('saml');
  });

  it('normalizes wildcard bind hosts for browser navigation', () => {
    expect(browserHostFor('0.0.0.0')).toBe('127.0.0.1');
    expect(browserHostFor('::')).toBe('127.0.0.1');
    expect(browserHostFor('localhost')).toBe('localhost');
  });

  it('resolves development runtime paths from the desktop package root', () => {
    const paths = resolveRuntimePaths({
      appRoot: '/repo/desktop',
      resourcesPath: '/repo/desktop',
      userDataPath: '/Users/test/Library/Application Support/MOZI',
      isPackaged: false,
      env: {
        npm_node_execpath: '/opt/node/bin/node',
        MOZI_SERVER_HOST: '0.0.0.0',
        MOZI_SERVER_PORT: '9222',
      } as NodeJS.ProcessEnv,
    });

    expect(paths.runtimeRoot).toBe('/repo');
    expect(paths.entryPath).toBe('/repo/dist/index.js');
    expect(paths.nodePath).toBe('/opt/node/bin/node');
    expect(paths.pythonPath).toBeUndefined();
    expect(paths.runtimeUrl).toBe('http://127.0.0.1:9222/');
  });

  it('resolves the packaged managed Python runtime independently of the host PATH', () => {
    const paths = resolveRuntimePaths({
      appRoot: '/Applications/MOZI.app/Contents/Resources/app.asar',
      resourcesPath: '/Applications/MOZI.app/Contents/Resources',
      userDataPath: '/Users/test/Library/Application Support/MOZI',
      isPackaged: true,
      env: {} as NodeJS.ProcessEnv,
    });

    expect(paths.pythonPath).toBe('/Applications/MOZI.app/Contents/Resources/python/bin/python3');
  });

  it('connects to an already healthy runtime without spawning', async () => {
    const spawnImpl = vi.fn();
    const paths = makePaths();
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl: vi.fn(async () => fetchResponse(true, { ok: true, pid: 123, mozi_home: paths.moziHome })),
      spawnImpl,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('ready');
    expect(state.owner).toBe('external');
    expect(state.pid).toBe(123);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('refuses to attach when health reports a different MOZI home', async () => {
    const paths = makePaths();
    const spawnImpl = vi.fn();
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl: vi.fn(async () => fetchResponse(true, { ok: true, pid: 123, mozi_home: '/Users/test/.mozi' })),
      spawnImpl,
      startupTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('failed');
    expect(state.error).toContain('is using MOZI_HOME /Users/test/.mozi');
    expect(state.error).toContain(paths.moziHome);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('reports missing runtime files as deterministic startup failures', async () => {
    const paths = makePaths({ entryPath: '/missing/mozi/dist/index.js' });
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl: vi.fn(async () => fetchResponse(false, {})),
      spawnImpl: vi.fn(),
      startupTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('failed');
    expect(state.error).toContain('MOZI runtime entrypoint not found');
  });

  it('reports a missing managed Python runtime as a deterministic startup failure', async () => {
    const paths = makePaths({ pythonPath: '/missing/mozi-python' });
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl: vi.fn(async () => fetchResponse(false, {})),
      spawnImpl: vi.fn(),
      startupTimeoutMs: 1,
      pollIntervalMs: 1,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('failed');
    expect(state.error).toContain('Managed Python document runtime not found');
  });

  it('spawns the runtime and waits until health passes', async () => {
    const paths = makePaths();
    paths.pythonPath = join(paths.runtimeRoot, 'python', 'bin', 'python3');
    mkdirSync(join(paths.runtimeRoot, 'python', 'bin'), { recursive: true });
    writeFileSync(paths.pythonPath, '');
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 456;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse(false, {}))
      .mockResolvedValueOnce(fetchResponse(false, {}))
      .mockResolvedValueOnce(fetchResponse(true, { ok: true, pid: 456, mozi_home: paths.moziHome }));
    const spawnImpl = vi.fn(() => child);
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl,
      spawnImpl,
      startupTimeoutMs: 100,
      pollIntervalMs: 1,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('ready');
    expect(state.owner).toBe('desktop');
    expect(state.pid).toBe(456);
    expect(spawnImpl).toHaveBeenCalledWith(
      paths.nodePath,
      [paths.entryPath],
      expect.objectContaining({
        cwd: paths.runtimeRoot,
        detached: false,
        env: expect.objectContaining({
          MOZI_DESKTOP: '1',
          MOZI_BUILD_SURFACE: 'desktop',
          MOZI_DESKTOP_MANAGED_HOME: '1',
          MOZI_HOME: paths.moziHome,
          MOZI_SERVER_AUTH_MODE: 'local',
          MOZI_PYTHON: paths.pythonPath,
          PYTHONNOUSERSITE: '1',
          PATH: expect.stringContaining('/usr/bin'),
        }),
      }),
    );
  });

  it('marks an explicit desktop MOZI_HOME as unmanaged for runtime diagnostics', async () => {
    const pathsBase = makePaths();
    const customHome = join(pathsBase.runtimeRoot, 'custom-mozi-home');
    const paths = {
      ...pathsBase,
      moziHome: customHome,
      logPath: join(customHome, 'logs', 'mozi.log'),
    };
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 457;
    child.killed = false;
    child.kill = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse(false, {}))
      .mockResolvedValueOnce(fetchResponse(true, { ok: true, pid: 457, mozi_home: paths.moziHome }));
    const spawnImpl = vi.fn(() => child);
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      env: { MOZI_HOME: paths.moziHome } as NodeJS.ProcessEnv,
      fetchImpl,
      spawnImpl,
      startupTimeoutMs: 100,
      pollIntervalMs: 1,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('ready');
    expect(spawnImpl).toHaveBeenCalledWith(
      paths.nodePath,
      [paths.entryPath],
      expect.objectContaining({
        env: expect.objectContaining({
          MOZI_DESKTOP: '1',
          MOZI_BUILD_SURFACE: 'desktop',
          MOZI_DESKTOP_MANAGED_HOME: '0',
          MOZI_HOME: paths.moziHome,
        }),
      }),
    );
  });

  it('does not stop an external runtime', async () => {
    const spawnImpl = vi.fn();
    const paths = makePaths();
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl: vi.fn(async () => fetchResponse(true, { ok: true, pid: 123, mozi_home: paths.moziHome })),
      spawnImpl,
    });

    await supervisor.ensureReady();
    await supervisor.stopOwnedProcess();

    expect(supervisor.getState().status).toBe('ready');
    expect(supervisor.getState().owner).toBe('external');
  });

  it('stops exactly the app-owned child process', async () => {
    const paths = makePaths();
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 789;
    child.killed = false;
    child.kill = vi.fn(() => {
      child.killed = true;
      return true;
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse(false, {}))
      .mockResolvedValueOnce(fetchResponse(true, { ok: true, pid: 789, mozi_home: paths.moziHome }));
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl,
      spawnImpl: vi.fn(() => child),
      startupTimeoutMs: 100,
      pollIntervalMs: 1,
    });

    await supervisor.ensureReady();
    const stopping = supervisor.stopOwnedProcess();
    child.emit('exit', 0, null);
    await stopping;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(supervisor.getState().status).toBe('stopped');
    expect(supervisor.getState().owner).toBe('none');
  });

  it('escalates to SIGKILL only when graceful shutdown times out', async () => {
    const paths = makePaths();
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 790;
    child.killed = false;
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null, 'SIGKILL'));
      return true;
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse(false, {}))
      .mockResolvedValueOnce(fetchResponse(true, { ok: true, pid: 790, mozi_home: paths.moziHome }));
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl,
      spawnImpl: vi.fn(() => child),
      startupTimeoutMs: 100,
      pollIntervalMs: 1,
      shutdownTimeoutMs: 1,
      forceKillTimeoutMs: 20,
    });

    await supervisor.ensureReady();
    const state = await supervisor.stopOwnedProcess();

    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(state.status).toBe('stopped');
    expect(state.owner).toBe('none');
  });

  it('reaps an owned child when startup times out', async () => {
    const paths = makePaths();
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 791;
    child.killed = false;
    child.kill = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0, null));
      return true;
    });
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl: vi.fn(async () => fetchResponse(false, {})),
      spawnImpl: vi.fn(() => child),
      startupTimeoutMs: 1,
      pollIntervalMs: 1,
      shutdownTimeoutMs: 20,
    });

    const state = await supervisor.ensureReady();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(state.status).toBe('failed');
    expect(state.error).toContain('did not become healthy');
  });

  it('preserves desktop ownership when an owned runtime is already healthy', async () => {
    const paths = makePaths();
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 654;
    child.killed = false;
    child.kill = vi.fn();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fetchResponse(false, {}))
      .mockResolvedValue(fetchResponse(true, { ok: true, pid: 654, mozi_home: paths.moziHome }));
    const supervisor = new MoziRuntimeSupervisor({
      paths,
      fetchImpl,
      spawnImpl: vi.fn(() => child),
      startupTimeoutMs: 100,
      pollIntervalMs: 1,
    });

    await supervisor.ensureReady();
    const state = await supervisor.ensureReady();

    expect(state.status).toBe('ready');
    expect(state.owner).toBe('desktop');
  });

  it('reports spawn errors deterministically', async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number; killed: boolean; kill: ReturnType<typeof vi.fn> };
    child.pid = 999;
    child.killed = false;
    child.kill = vi.fn();
    const supervisor = new MoziRuntimeSupervisor({
      paths: makePaths(),
      fetchImpl: vi.fn(async () => fetchResponse(false, {})),
      spawnImpl: vi.fn(() => {
        queueMicrotask(() => child.emit('error', new Error('EACCES')));
        return child;
      }),
      startupTimeoutMs: 50,
      pollIntervalMs: 1,
    });

    const state = await supervisor.ensureReady();

    expect(state.status).toBe('failed');
    expect(supervisor.getState().error).toContain('EACCES');
  });
});
