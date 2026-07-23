import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from '../test-helpers.js';

const hoisted = vi.hoisted(() => {
  const availableCommands = new Set<string>(['gnome-screenshot', 'wmctrl', 'xdotool']);
  const createApprovalRequestMock = vi.fn(() => ({ id: 'approval-desktop-1' }));
  const formatApprovalNotificationMock = vi.fn(() => '[APPROVAL NEEDED] ID: approval-desktop-1 Use /approve approval-desktop-1');
  const getRequestMock = vi.fn(() => ({ id: 'approval-desktop-1', status: 'approved' }));
  const mockHardGates: string[] = [];
  const execFileSyncMock = vi.fn((command: string, args: string[]) => {
    if (command === 'which') {
      if (!availableCommands.has(args[0]!)) {
        throw new Error(`not found: ${args[0]}`);
      }
      return `/usr/bin/${args[0]}`;
    }
    if (command === 'gnome-screenshot') {
      const outputPath = args[1]!;
      writeFileSync(outputPath, 'png');
      return '';
    }
    if (command === 'wmctrl' && args[0] === '-lx') {
      return [
        '0x01200003  0 host code.Code Visual Studio Code',
        '0x02200007  0 host firefox.Firefox Mozilla Firefox',
      ].join('\n');
    }
    if (command === 'wmctrl' && (args[0] === '-ia' || args[0] === '-a')) {
      return '';
    }
    if (command === 'xdotool' && args[0] === 'getactivewindow') {
      return '0x01200003';
    }
    if (command === 'xdotool') {
      return '';
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  });
  const spawnMock = vi.fn(() => ({
    pid: 4242,
    unref: vi.fn(),
  }));

  return {
    availableCommands,
    createApprovalRequestMock,
    formatApprovalNotificationMock,
    getRequestMock,
    mockHardGates,
    execFileSyncMock,
    spawnMock,
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: hoisted.execFileSyncMock,
  spawn: hoisted.spawnMock,
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    security: { hard_gates: hoisted.mockHardGates },
  }),
}));

vi.mock('../security/gates.js', () => ({
  createApprovalRequest: hoisted.createApprovalRequestMock,
  formatApprovalNotification: hoisted.formatApprovalNotificationMock,
  getRequest: hoisted.getRequestMock,
}));

import {
  takeDesktopScreenshot,
  listDesktopWindows,
  focusDesktopWindow,
  launchDesktopApp,
  desktopClick,
  desktopTypeText,
  desktopPressHotkey,
} from './desktop.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = createTempDir();
});

afterAll(() => {
  removeTempDir(tmpDir);
});

beforeEach(() => {
  hoisted.execFileSyncMock.mockClear();
  hoisted.spawnMock.mockClear();
  hoisted.createApprovalRequestMock.mockClear();
  hoisted.formatApprovalNotificationMock.mockClear();
  hoisted.getRequestMock.mockClear();
  hoisted.mockHardGates.length = 0;
});

describe('capabilities/desktop', () => {
  it('captures a desktop screenshot on linux', async () => {
    const outputPath = join(tmpDir, 'desktop.png');
    const result = await takeDesktopScreenshot({ path: outputPath, platform: 'linux' });

    expect(result.path).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
  });

  it('lists desktop windows and marks the active one', async () => {
    const windows = await listDesktopWindows({ platform: 'linux' });
    expect(windows).toEqual([
      expect.objectContaining({ id: '0x01200003', app: 'Code', active: true }),
      expect.objectContaining({ id: '0x02200007', app: 'Firefox', active: false }),
    ]);
  });

  it('focuses, types, clicks, presses hotkeys, and launches apps on linux', async () => {
    await focusDesktopWindow({ windowId: '0x01200003', platform: 'linux' });
    await desktopTypeText({ text: 'hello', platform: 'linux' });
    await desktopClick({ x: 100, y: 200, platform: 'linux' });
    await desktopPressHotkey({ keys: ['ctrl', 'l'], platform: 'linux' });
    const launch = await launchDesktopApp({ command: 'code', args: ['.'], cwd: tmpDir, platform: undefined as never });

    expect(launch.pid).toBe(4242);
    expect(hoisted.spawnMock).toHaveBeenCalledWith('code', ['.'], expect.objectContaining({
      cwd: tmpDir,
      detached: true,
    }));
  });

  it('requires approval for gated desktop actions', async () => {
    hoisted.mockHardGates.push('desktop_control');

    await expect(desktopClick({
      x: 10,
      y: 20,
      tenantId: 'default',
      platform: 'linux',
    })).rejects.toThrow('/approve');

    expect(hoisted.createApprovalRequestMock).toHaveBeenCalledOnce();
  });

  it('accepts approved request ids for gated actions', async () => {
    hoisted.mockHardGates.push('desktop_control');

    const result = await desktopTypeText({
      text: 'approved',
      approvalRequestId: 'approval-desktop-1',
      tenantId: 'default',
      platform: 'linux',
    });

    expect(result).toContain('Typed');
    expect(hoisted.getRequestMock).toHaveBeenCalledWith('approval-desktop-1', 'default');
  });
});
