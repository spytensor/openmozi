import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import pino from 'pino';
import { getConfig } from '../config/index.js';
import { createApprovalRequest, formatApprovalNotification, getRequest } from '../security/gates.js';

const logger = pino({ name: 'mozi:capability:desktop' });

export type DesktopPlatform = 'linux' | 'darwin' | 'win32';

export interface DesktopWindow {
  id: string;
  title: string;
  app: string;
  platform: DesktopPlatform;
  active: boolean;
}

export interface DesktopLaunchResult {
  command: string;
  pid: number | null;
}

function resolvePlatform(platform?: NodeJS.Platform): DesktopPlatform {
  const current = platform ?? process.platform;
  if (current === 'linux' || current === 'darwin' || current === 'win32') {
    return current;
  }
  throw new Error(`Unsupported desktop platform: ${current}`);
}

function resolveMaybeHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return resolve(homedir(), path.slice(2));
  }
  return resolve(path);
}

function commandExists(command: string, platform: DesktopPlatform): boolean {
  try {
    execFileSync(platform === 'win32' ? 'where' : 'which', [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function runTextCommand(
  command: string,
  args: string[],
  timeoutMs = 15_000,
): string {
  try {
    return execFileSync(command, args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${command} failed: ${message}`);
  }
}

function normalizeWindowId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('0x')) return trimmed;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric >= 0) {
    return `0x${numeric.toString(16)}`;
  }
  return trimmed;
}

function requireDesktopApproval(
  action: 'launch' | 'click' | 'type' | 'hotkey',
  tenantId: string,
  payload: Record<string, unknown>,
  approvalRequestId?: string,
): void {
  const hardGates = getConfig().security.hard_gates ?? [];
  if (!hardGates.includes('desktop_control')) return;

  const requestId = approvalRequestId?.trim();
  if (requestId) {
    const request = getRequest(requestId, tenantId);
    if (!request) throw new Error(`Approval request not found: ${requestId}`);
    if (request.status !== 'approved') {
      throw new Error(`Approval request ${requestId} is ${request.status}. Use /approve ${requestId} first.`);
    }
    return;
  }

  const request = createApprovalRequest(
    'desktop_control',
    `Desktop ${action} requires approval`,
    payload,
    'desktop_tool',
    tenantId,
  );
  throw new Error(formatApprovalNotification(request));
}

function ensureLinuxDesktopCommand(name: string): void {
  if (!commandExists(name, 'linux')) {
    throw new Error(`Desktop action requires "${name}" on Linux, but it is not installed.`);
  }
}

function ensureMacDesktopCommand(name: string): void {
  if (!commandExists(name, 'darwin')) {
    throw new Error(`Desktop action requires "${name}" on macOS, but it is not installed.`);
  }
}

function ensureScreenshotPath(path?: string): string {
  const resolved = path ? resolveMaybeHome(path) : resolve(tmpdir(), `mozi-desktop-${Date.now()}.png`);
  mkdirSync(dirname(resolved), { recursive: true });
  return resolved;
}

function screenshotLinux(targetPath: string): void {
  if (commandExists('gnome-screenshot', 'linux')) {
    runTextCommand('gnome-screenshot', ['-f', targetPath]);
    return;
  }
  if (commandExists('scrot', 'linux')) {
    runTextCommand('scrot', [targetPath]);
    return;
  }
  if (commandExists('import', 'linux')) {
    runTextCommand('import', ['-window', 'root', targetPath]);
    return;
  }
  throw new Error('Desktop screenshot on Linux requires one of: gnome-screenshot, scrot, import.');
}

function screenshotMac(targetPath: string): void {
  ensureMacDesktopCommand('screencapture');
  runTextCommand('screencapture', ['-x', targetPath]);
}

function screenshotWindows(targetPath: string): void {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen;',
    '$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;',
    '$graphics = [System.Drawing.Graphics]::FromImage($bitmap);',
    '$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);',
    `$bitmap.Save('${targetPath.replace(/'/g, "''")}');`,
    '$graphics.Dispose();',
    '$bitmap.Dispose();',
  ].join(' ');
  runTextCommand('powershell', ['-NoProfile', '-Command', script], 20_000);
}

function listWindowsLinux(): DesktopWindow[] {
  ensureLinuxDesktopCommand('wmctrl');
  const activeWindowId = commandExists('xdotool', 'linux')
    ? normalizeWindowId(runTextCommand('xdotool', ['getactivewindow']).trim())
    : '';
  const output = runTextCommand('wmctrl', ['-lx']);
  if (!output) return [];

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const id = parts[0] ?? '';
      const wmClass = parts[3] ?? '';
      const title = parts.slice(4).join(' ').trim();
      const app = wmClass.split('.').pop() || wmClass || 'unknown';
      return {
        id,
        title,
        app,
        platform: 'linux' as const,
        active: activeWindowId !== '' && normalizeWindowId(id) === activeWindowId,
      };
    });
}

function listWindowsMac(): DesktopWindow[] {
  ensureMacDesktopCommand('osascript');
  const script = 'tell application "System Events" to get the name of every application process whose background only is false';
  const output = runTextCommand('osascript', ['-e', script]);
  if (!output) return [];
  return output
    .split(/,\s*/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      id: name,
      title: name,
      app: name,
      platform: 'darwin' as const,
      active: false,
    }));
}

function listWindowsWindows(): DesktopWindow[] {
  const script = '(gps | ? {$_.MainWindowTitle -and $_.MainWindowTitle.Trim().Length -gt 0} | select Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress)';
  const output = runTextCommand('powershell', ['-NoProfile', '-Command', script], 20_000);
  if (!output) return [];
  const parsed = JSON.parse(output) as Array<{ Id: number; ProcessName: string; MainWindowTitle: string }> | { Id: number; ProcessName: string; MainWindowTitle: string };
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => ({
    id: String(row.Id),
    title: row.MainWindowTitle,
    app: row.ProcessName,
    platform: 'win32' as const,
    active: false,
  }));
}

function focusWindowLinux(options: { windowId?: string; title?: string }): string {
  if (options.windowId) {
    if (commandExists('wmctrl', 'linux')) {
      runTextCommand('wmctrl', ['-ia', options.windowId]);
    } else {
      ensureLinuxDesktopCommand('xdotool');
      runTextCommand('xdotool', ['windowactivate', options.windowId]);
    }
    return `Focused window ${options.windowId}`;
  }

  const title = options.title?.trim();
  if (!title) {
    throw new Error('Either windowId or title is required.');
  }
  if (commandExists('wmctrl', 'linux')) {
    runTextCommand('wmctrl', ['-a', title]);
  } else {
    ensureLinuxDesktopCommand('xdotool');
    runTextCommand('xdotool', ['search', '--name', title, 'windowactivate', '%@']);
  }
  return `Focused window title: ${title}`;
}

function focusWindowMac(options: { windowId?: string; title?: string }): string {
  ensureMacDesktopCommand('osascript');
  const target = options.title?.trim() || options.windowId?.trim();
  if (!target) throw new Error('Either windowId or title is required.');
  runTextCommand('osascript', ['-e', `tell application "${target.replace(/"/g, '\\"')}" to activate`]);
  return `Focused application: ${target}`;
}

function focusWindowWindows(options: { windowId?: string; title?: string }): string {
  const target = options.title?.trim() || options.windowId?.trim();
  if (!target) throw new Error('Either windowId or title is required.');
  const script = options.windowId
    ? [
      '$wshell = New-Object -ComObject WScript.Shell;',
      `$null = $wshell.AppActivate(${Number(target)});`,
    ].join(' ')
    : [
      '$wshell = New-Object -ComObject WScript.Shell;',
      `$null = $wshell.AppActivate('${target.replace(/'/g, "''")}');`,
    ].join(' ');
  runTextCommand('powershell', ['-NoProfile', '-Command', script], 20_000);
  return `Focused window: ${target}`;
}

function desktopTypeLinux(text: string): void {
  ensureLinuxDesktopCommand('xdotool');
  runTextCommand('xdotool', ['type', '--delay', '0', '--', text]);
}

function desktopHotkeyLinux(keys: string[]): void {
  ensureLinuxDesktopCommand('xdotool');
  runTextCommand('xdotool', ['key', keys.join('+')]);
}

function desktopClickLinux(x: number, y: number, button: number): void {
  ensureLinuxDesktopCommand('xdotool');
  runTextCommand('xdotool', ['mousemove', String(x), String(y), 'click', String(button)]);
}

function desktopTypeMac(text: string): void {
  ensureMacDesktopCommand('osascript');
  runTextCommand('osascript', ['-e', `tell application "System Events" to keystroke "${text.replace(/"/g, '\\"')}"`], 20_000);
}

function desktopHotkeyMac(keys: string[]): void {
  ensureMacDesktopCommand('osascript');
  if (keys.length === 0) throw new Error('At least one key is required.');
  const modifiers = keys.slice(0, -1).map((key) => {
    const normalized = key.toLowerCase();
    if (normalized === 'cmd' || normalized === 'command' || normalized === 'meta') return 'command down';
    if (normalized === 'ctrl' || normalized === 'control') return 'control down';
    if (normalized === 'alt' || normalized === 'option') return 'option down';
    if (normalized === 'shift') return 'shift down';
    throw new Error(`Unsupported macOS modifier: ${key}`);
  });
  const lastKey = keys[keys.length - 1]!;
  const using = modifiers.length > 0 ? ` using {${modifiers.join(', ')}}` : '';
  runTextCommand('osascript', ['-e', `tell application "System Events" to keystroke "${lastKey.replace(/"/g, '\\"')}"${using}`], 20_000);
}

function desktopClickMac(x: number, y: number): void {
  if (commandExists('cliclick', 'darwin')) {
    runTextCommand('cliclick', [`c:${x},${y}`]);
    return;
  }
  throw new Error('Desktop click on macOS requires "cliclick".');
}

function desktopTypeWindows(text: string): void {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    `[System.Windows.Forms.SendKeys]::SendWait('${text.replace(/'/g, "''")}');`,
  ].join(' ');
  runTextCommand('powershell', ['-NoProfile', '-Command', script], 20_000);
}

function toWindowsSendKeys(keys: string[]): string {
  return keys.map((key) => {
    const normalized = key.toLowerCase();
    if (normalized === 'ctrl' || normalized === 'control') return '^';
    if (normalized === 'alt') return '%';
    if (normalized === 'shift') return '+';
    if (normalized === 'meta' || normalized === 'cmd' || normalized === 'command') return '^{ESC}';
    return key;
  }).join('');
}

function desktopHotkeyWindows(keys: string[]): void {
  const sendKeys = toWindowsSendKeys(keys);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    `[System.Windows.Forms.SendKeys]::SendWait('${sendKeys.replace(/'/g, "''")}');`,
  ].join(' ');
  runTextCommand('powershell', ['-NoProfile', '-Command', script], 20_000);
}

function desktopClickWindows(x: number, y: number): void {
  const script = [
    'Add-Type @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class MouseInput {',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);',
    '}',
    '\'@;',
    `[MouseInput]::SetCursorPos(${x}, ${y}) | Out-Null;`,
    '[MouseInput]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero);',
    '[MouseInput]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero);',
  ].join(' ');
  runTextCommand('powershell', ['-NoProfile', '-Command', script], 20_000);
}

export async function takeDesktopScreenshot(options: {
  path?: string;
  platform?: NodeJS.Platform;
} = {}): Promise<{ path: string }> {
  const platform = resolvePlatform(options.platform);
  const screenshotPath = ensureScreenshotPath(options.path);

  switch (platform) {
    case 'linux':
      screenshotLinux(screenshotPath);
      break;
    case 'darwin':
      screenshotMac(screenshotPath);
      break;
    case 'win32':
      screenshotWindows(screenshotPath);
      break;
  }

  if (!existsSync(screenshotPath)) {
    throw new Error(`Desktop screenshot did not create the expected file: ${screenshotPath}`);
  }
  return { path: screenshotPath };
}

export async function listDesktopWindows(options: {
  platform?: NodeJS.Platform;
} = {}): Promise<DesktopWindow[]> {
  const platform = resolvePlatform(options.platform);
  switch (platform) {
    case 'linux': return listWindowsLinux();
    case 'darwin': return listWindowsMac();
    case 'win32': return listWindowsWindows();
  }
}

export async function focusDesktopWindow(options: {
  windowId?: string;
  title?: string;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const platform = resolvePlatform(options.platform);
  switch (platform) {
    case 'linux': return focusWindowLinux(options);
    case 'darwin': return focusWindowMac(options);
    case 'win32': return focusWindowWindows(options);
  }
}

export async function launchDesktopApp(options: {
  command: string;
  args?: string[];
  cwd?: string;
  tenantId?: string;
  approvalRequestId?: string;
}): Promise<DesktopLaunchResult> {
  const tenantId = options.tenantId ?? 'default';
  requireDesktopApproval('launch', tenantId, {
    command: options.command,
    args: options.args ?? [],
    cwd: options.cwd ?? null,
  }, options.approvalRequestId);

  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd ? (isAbsolute(options.cwd) ? options.cwd : resolveMaybeHome(options.cwd)) : undefined,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  logger.info({ command: options.command, pid: child.pid ?? null }, 'Desktop app launched');
  return {
    command: options.command,
    pid: child.pid ?? null,
  };
}

export async function desktopClick(options: {
  x: number;
  y: number;
  button?: number;
  tenantId?: string;
  approvalRequestId?: string;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const platform = resolvePlatform(options.platform);
  const tenantId = options.tenantId ?? 'default';
  const button = options.button ?? 1;
  requireDesktopApproval('click', tenantId, {
    x: options.x,
    y: options.y,
    button,
  }, options.approvalRequestId);

  switch (platform) {
    case 'linux':
      desktopClickLinux(options.x, options.y, button);
      break;
    case 'darwin':
      desktopClickMac(options.x, options.y);
      break;
    case 'win32':
      desktopClickWindows(options.x, options.y);
      break;
  }

  return `Clicked desktop at (${options.x}, ${options.y})`;
}

export async function desktopTypeText(options: {
  text: string;
  tenantId?: string;
  approvalRequestId?: string;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const platform = resolvePlatform(options.platform);
  const tenantId = options.tenantId ?? 'default';
  requireDesktopApproval('type', tenantId, {
    text_preview: options.text.slice(0, 120),
  }, options.approvalRequestId);

  switch (platform) {
    case 'linux':
      desktopTypeLinux(options.text);
      break;
    case 'darwin':
      desktopTypeMac(options.text);
      break;
    case 'win32':
      desktopTypeWindows(options.text);
      break;
  }

  return `Typed ${options.text.length} characters into the desktop`;
}

export async function desktopPressHotkey(options: {
  keys: string[];
  tenantId?: string;
  approvalRequestId?: string;
  platform?: NodeJS.Platform;
}): Promise<string> {
  const platform = resolvePlatform(options.platform);
  const tenantId = options.tenantId ?? 'default';
  if (!Array.isArray(options.keys) || options.keys.length === 0) {
    throw new Error('At least one key is required.');
  }
  requireDesktopApproval('hotkey', tenantId, {
    keys: options.keys,
  }, options.approvalRequestId);

  switch (platform) {
    case 'linux':
      desktopHotkeyLinux(options.keys);
      break;
    case 'darwin':
      desktopHotkeyMac(options.keys);
      break;
    case 'win32':
      desktopHotkeyWindows(options.keys);
      break;
  }

  return `Pressed hotkey: ${options.keys.join('+')}`;
}
