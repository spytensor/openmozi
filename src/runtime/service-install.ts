/**
 * Service installer — makes MOZI start on boot.
 *
 * Linux: writes a systemd user unit to `~/.config/systemd/user/mozi.service`.
 *   By default the service runs when the user logs in. To run headless (no
 *   login), the user must also run `sudo loginctl enable-linger $USER`.
 *
 * macOS: writes a launchd user agent plist to
 *   `~/Library/LaunchAgents/ai.mozi.agent.plist`, loaded via `launchctl`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { getLogPath } from '../paths.js';
import { resolveDaemonCwd, resolveMainEntryPath } from './daemon.js';

const execFileAsync = promisify(execFile);

export type ServicePlatform = 'linux' | 'darwin' | 'unsupported';

export interface ServicePaths {
  platform: ServicePlatform;
  unitName: string;
  unitPath: string;
  logPath: string;
}

export interface UnitRenderOptions {
  nodePath: string;
  entryPath: string;
  workingDir: string;
  logPath: string;
  env?: Record<string, string>;
}

export type ServiceInstallResult =
  | { ok: true; platform: ServicePlatform; unitPath: string; started: boolean; logPath: string; linger?: boolean }
  | { ok: false; error: string };

export type ServiceUninstallResult =
  | { ok: true; unitPath: string }
  | { ok: false; error: string };

export type ServiceStatusResult =
  | { installed: false; platform: ServicePlatform }
  | {
      installed: true;
      platform: ServicePlatform;
      unitPath: string;
      active: boolean;
      enabled: boolean;
    };

export function detectServicePlatform(plat: NodeJS.Platform = platform()): ServicePlatform {
  if (plat === 'linux') return 'linux';
  if (plat === 'darwin') return 'darwin';
  return 'unsupported';
}

export function resolveServicePaths(home: string = homedir(), plat: ServicePlatform = detectServicePlatform()): ServicePaths {
  const logPath = getLogPath();
  if (plat === 'linux') {
    return {
      platform: plat,
      unitName: 'mozi.service',
      unitPath: join(home, '.config', 'systemd', 'user', 'mozi.service'),
      logPath,
    };
  }
  if (plat === 'darwin') {
    return {
      platform: plat,
      unitName: 'ai.mozi.agent',
      unitPath: join(home, 'Library', 'LaunchAgents', 'ai.mozi.agent.plist'),
      logPath,
    };
  }
  return { platform: plat, unitName: '', unitPath: '', logPath };
}

function escapeSystemdEnvironment(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseLaunchctlListStatus(stdout: string, label: string): { active: boolean; enabled: boolean } {
  const labelPattern = new RegExp(`\\s${escapeRegExp(label)}$`);
  const line = stdout
    .split('\n')
    .map(item => item.trim())
    .find(item => labelPattern.test(` ${item}`));
  if (!line) {
    return { active: false, enabled: false };
  }

  const [pid] = line.split(/\s+/);
  return {
    enabled: true,
    active: /^\d+$/.test(pid) && Number(pid) > 0,
  };
}

export function buildServiceEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const serviceEnv: Record<string, string> = {
    MOZI_HOME: env.MOZI_HOME ?? join(env.HOME ?? homedir(), '.mozi'),
  };
  if (env.MOZI_SERVER_HOST) {
    serviceEnv.MOZI_SERVER_HOST = env.MOZI_SERVER_HOST;
  }
  if (env.MOZI_SERVER_PORT) {
    serviceEnv.MOZI_SERVER_PORT = env.MOZI_SERVER_PORT;
  }
  if (env.MOZI_DESKTOP) {
    serviceEnv.MOZI_DESKTOP = env.MOZI_DESKTOP;
  }
  if (env.MOZI_DESKTOP_MANAGED_HOME) {
    serviceEnv.MOZI_DESKTOP_MANAGED_HOME = env.MOZI_DESKTOP_MANAGED_HOME;
  }
  return serviceEnv;
}

export function renderLinuxUnit(opts: UnitRenderOptions): string {
  const envLines = Object.entries(opts.env ?? {})
    .map(([key, value]) => `Environment="${key}=${escapeSystemdEnvironment(value)}"`)
    .join('\n');
  return `[Unit]
Description=MOZI Autonomous Agent Operating System
Documentation=https://github.com/MoziAI/Mozi
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${opts.workingDir}
ExecStart=${opts.nodePath} ${opts.entryPath}
Restart=on-failure
RestartSec=5
StandardOutput=append:${opts.logPath}
StandardError=append:${opts.logPath}
Environment=NODE_ENV=production
${envLines}

[Install]
WantedBy=default.target
`;
}

export function renderMacOSPlist(opts: UnitRenderOptions & { label: string }): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const env = { NODE_ENV: 'production', ...(opts.env ?? {}) };
  const envEntries = Object.entries(env)
    .map(([key, value]) => `    <key>${escape(key)}</key>\n    <string>${escape(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escape(opts.label)}</string>
  <key>WorkingDirectory</key>
  <string>${escape(opts.workingDir)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escape(opts.nodePath)}</string>
    <string>${escape(opts.entryPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(opts.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries}
  </dict>
</dict>
</plist>
`;
}

async function which(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-c', `command -v ${cmd}`]);
    return true;
  } catch {
    return false;
  }
}

export interface InstallOptions {
  cwd?: string;
  /** If false, don't start after install (just enable). Defaults to true. */
  startNow?: boolean;
}

export async function installService(options: InstallOptions = {}): Promise<ServiceInstallResult> {
  const plat = detectServicePlatform();
  if (plat === 'unsupported') {
    return { ok: false, error: `Unsupported platform: ${platform()}. Only Linux and macOS are supported.` };
  }

  const cwd = options.cwd ?? process.cwd();
  const entry = resolveMainEntryPath(cwd);
  if (!entry) {
    return {
      ok: false,
      error: 'Cannot locate runtime entrypoint (dist/index.js). Run `pnpm build` first.',
    };
  }
  const workingDir = resolveDaemonCwd(entry, cwd);
  const paths = resolveServicePaths();

  if (plat === 'linux' && !(await which('systemctl'))) {
    return { ok: false, error: '`systemctl` not found. systemd is required on Linux.' };
  }
  if (plat === 'darwin' && !(await which('launchctl'))) {
    return { ok: false, error: '`launchctl` not found.' };
  }

  const render: UnitRenderOptions = {
    nodePath: process.execPath,
    entryPath: entry,
    workingDir,
    logPath: paths.logPath,
    env: buildServiceEnvironment(),
  };

  try {
    mkdirSync(dirname(paths.unitPath), { recursive: true, mode: 0o755 });
    mkdirSync(dirname(paths.logPath), { recursive: true, mode: 0o700 });

    const content =
      plat === 'linux'
        ? renderLinuxUnit(render)
        : renderMacOSPlist({ ...render, label: paths.unitName });
    writeFileSync(paths.unitPath, content, { mode: 0o644 });

    const startNow = options.startNow !== false;
    let started = false;
    let linger: boolean | undefined;

    if (plat === 'linux') {
      await execFileAsync('systemctl', ['--user', 'daemon-reload']);
      await execFileAsync('systemctl', ['--user', 'enable', paths.unitName]);
      if (startNow) {
        await execFileAsync('systemctl', ['--user', 'restart', paths.unitName]);
        started = true;
      }
      linger = await isLingerEnabled();
    } else {
      // macOS: unload any previous version (ignore failure), then load.
      try {
        await execFileAsync('launchctl', ['unload', paths.unitPath]);
      } catch {
        // not previously loaded
      }
      if (startNow) {
        await execFileAsync('launchctl', ['load', '-w', paths.unitPath]);
        started = true;
      }
    }

    return { ok: true, platform: plat, unitPath: paths.unitPath, started, logPath: paths.logPath, linger };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uninstallService(): Promise<ServiceUninstallResult> {
  const plat = detectServicePlatform();
  if (plat === 'unsupported') {
    return { ok: false, error: `Unsupported platform: ${platform()}` };
  }
  const paths = resolveServicePaths();
  if (!existsSync(paths.unitPath)) {
    return { ok: false, error: `Service not installed (no unit at ${paths.unitPath}).` };
  }

  try {
    if (plat === 'linux') {
      // Best-effort stop + disable; ignore individual failures so uninstall is idempotent.
      try { await execFileAsync('systemctl', ['--user', 'stop', paths.unitName]); } catch { /* not running */ }
      try { await execFileAsync('systemctl', ['--user', 'disable', paths.unitName]); } catch { /* not enabled */ }
      rmSync(paths.unitPath, { force: true });
      try { await execFileAsync('systemctl', ['--user', 'daemon-reload']); } catch { /* best effort */ }
    } else {
      try { await execFileAsync('launchctl', ['unload', paths.unitPath]); } catch { /* not loaded */ }
      rmSync(paths.unitPath, { force: true });
    }
    return { ok: true, unitPath: paths.unitPath };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getServiceStatus(): Promise<ServiceStatusResult> {
  const plat = detectServicePlatform();
  if (plat === 'unsupported') {
    return { installed: false, platform: plat };
  }
  const paths = resolveServicePaths();
  if (!existsSync(paths.unitPath)) {
    return { installed: false, platform: plat };
  }

  let active = false;
  let enabled = false;

  if (plat === 'linux') {
    try {
      const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', paths.unitName]);
      active = stdout.trim() === 'active';
    } catch (err) {
      // `is-active` exits non-zero when inactive; parse stdout if present.
      const out = (err as { stdout?: string }).stdout;
      active = typeof out === 'string' && out.trim() === 'active';
    }
    try {
      const { stdout } = await execFileAsync('systemctl', ['--user', 'is-enabled', paths.unitName]);
      enabled = stdout.trim() === 'enabled';
    } catch (err) {
      const out = (err as { stdout?: string }).stdout;
      enabled = typeof out === 'string' && out.trim() === 'enabled';
    }
  } else {
    try {
      const { stdout } = await execFileAsync('launchctl', ['list']);
      // launchctl list format: PID  Status  Label
      const launchdStatus = parseLaunchctlListStatus(stdout, paths.unitName);
      active = launchdStatus.active;
      enabled = launchdStatus.enabled;
    } catch {
      active = false;
      enabled = false;
    }
  }

  return { installed: true, platform: plat, unitPath: paths.unitPath, active, enabled };
}

export async function isLingerEnabled(user: string = process.env.USER ?? ''): Promise<boolean> {
  if (!user) return false;
  try {
    const { stdout } = await execFileAsync('loginctl', ['show-user', user, '--property=Linger']);
    return stdout.trim() === 'Linger=yes';
  } catch {
    return false;
  }
}
