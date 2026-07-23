import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  takeDesktopScreenshotMock: vi.fn(),
  listDesktopWindowsMock: vi.fn(),
  focusDesktopWindowMock: vi.fn(),
  launchDesktopAppMock: vi.fn(),
  desktopClickMock: vi.fn(),
  desktopTypeTextMock: vi.fn(),
  desktopPressHotkeyMock: vi.fn(),
  clickDesktopTargetMock: vi.fn(),
  typeIntoDesktopTargetMock: vi.fn(),
}));

vi.mock('../capabilities/desktop.js', () => ({
  takeDesktopScreenshot: hoisted.takeDesktopScreenshotMock,
  listDesktopWindows: hoisted.listDesktopWindowsMock,
  focusDesktopWindow: hoisted.focusDesktopWindowMock,
  launchDesktopApp: hoisted.launchDesktopAppMock,
  desktopClick: hoisted.desktopClickMock,
  desktopTypeText: hoisted.desktopTypeTextMock,
  desktopPressHotkey: hoisted.desktopPressHotkeyMock,
}));

vi.mock('../capabilities/computer-use.js', () => ({
  clickDesktopTarget: hoisted.clickDesktopTargetMock,
  typeIntoDesktopTarget: hoisted.typeIntoDesktopTargetMock,
}));

import { executeDesktopTool, DESKTOP_TOOLS } from './desktop-tools.js';

describe('tools/desktop-tools', () => {
  it('registers all desktop tools', () => {
    const names = DESKTOP_TOOLS.map((tool) => tool.function.name);
    expect(names).toEqual([
      'desktop_screenshot',
      'desktop_list_windows',
      'desktop_focus_window',
      'desktop_launch_app',
      'desktop_click',
      'desktop_type',
      'desktop_hotkey',
      'desktop_click_hint',
      'desktop_type_hint',
    ]);
  });

  it('returns file_path for desktop screenshots', async () => {
    hoisted.takeDesktopScreenshotMock.mockResolvedValueOnce({ path: '/tmp/desktop-shot.png' });

    const result = await executeDesktopTool('desktop_screenshot', {}, 'call-shot');
    expect(result?.is_error).toBe(false);
    expect(result?.file_path).toBe('/tmp/desktop-shot.png');
  });

  it('forwards tenant-aware actions to capability layer', async () => {
    hoisted.desktopClickMock.mockResolvedValueOnce('clicked');
    hoisted.desktopTypeTextMock.mockResolvedValueOnce('typed');
    hoisted.desktopPressHotkeyMock.mockResolvedValueOnce('hotkey');
    hoisted.launchDesktopAppMock.mockResolvedValueOnce({ command: 'code', pid: 99 });

    const click = await executeDesktopTool('desktop_click', { x: 1, y: 2 }, 'call-click', { tenantId: 'tenant-a' });
    const type = await executeDesktopTool('desktop_type', { text: 'hello' }, 'call-type', { tenantId: 'tenant-a' });
    const hotkey = await executeDesktopTool('desktop_hotkey', { keys: ['ctrl', 'l'] }, 'call-hotkey', { tenantId: 'tenant-a' });
    const launch = await executeDesktopTool('desktop_launch_app', { command: 'code' }, 'call-launch', { tenantId: 'tenant-a' });

    expect(click?.is_error).toBe(false);
    expect(type?.is_error).toBe(false);
    expect(hotkey?.is_error).toBe(false);
    expect(launch?.is_error).toBe(false);
    expect(hoisted.desktopClickMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }));
    expect(hoisted.desktopTypeTextMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }));
    expect(hoisted.desktopPressHotkeyMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }));
    expect(hoisted.launchDesktopAppMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'tenant-a' }));
  });

  it('routes hint-based desktop tools to computer-use capability', async () => {
    hoisted.clickDesktopTargetMock.mockResolvedValueOnce('clicked by hint');
    hoisted.typeIntoDesktopTargetMock.mockResolvedValueOnce('typed by hint');

    const click = await executeDesktopTool('desktop_click_hint', { target: 'Save' }, 'call-click-hint', { tenantId: 'tenant-a' });
    const type = await executeDesktopTool('desktop_type_hint', { target: 'Search', text: 'hello' }, 'call-type-hint', { tenantId: 'tenant-a' });

    expect(click?.is_error).toBe(false);
    expect(type?.is_error).toBe(false);
    expect(hoisted.clickDesktopTargetMock).toHaveBeenCalledWith(expect.objectContaining({ target: 'Save', tenantId: 'tenant-a' }));
    expect(hoisted.typeIntoDesktopTargetMock).toHaveBeenCalledWith(expect.objectContaining({ target: 'Search', text: 'hello', tenantId: 'tenant-a' }));
  });
});
