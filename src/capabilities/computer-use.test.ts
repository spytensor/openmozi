import { describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  takeDesktopScreenshotMock: vi.fn(),
  desktopClickMock: vi.fn(),
  desktopTypeTextMock: vi.fn(),
  analyzeImageMock: vi.fn(),
}));

vi.mock('./desktop.js', () => ({
  takeDesktopScreenshot: hoisted.takeDesktopScreenshotMock,
  desktopClick: hoisted.desktopClickMock,
  desktopTypeText: hoisted.desktopTypeTextMock,
}));

vi.mock('./vision.js', () => ({
  analyzeImage: hoisted.analyzeImageMock,
}));

import { clickDesktopTarget, typeIntoDesktopTarget } from './computer-use.js';

describe('capabilities/computer-use', () => {
  it('clicks a desktop target via screenshot + vision coordinates', async () => {
    hoisted.takeDesktopScreenshotMock.mockResolvedValueOnce({ path: '/tmp/shot.png' });
    hoisted.analyzeImageMock.mockResolvedValueOnce('{"x": 320, "y": 180}');
    hoisted.desktopClickMock.mockResolvedValueOnce('Clicked desktop at (320, 180)');

    const result = await clickDesktopTarget({ target: 'Submit button', tenantId: 'default' });

    expect(hoisted.takeDesktopScreenshotMock).toHaveBeenCalledOnce();
    expect(hoisted.analyzeImageMock).toHaveBeenCalledWith(expect.stringMatching(/mozi-computer-use-.*\.png$/), expect.stringContaining('Target: Submit button'));
    expect(hoisted.desktopClickMock).toHaveBeenCalledWith(expect.objectContaining({ x: 320, y: 180, tenantId: 'default' }));
    expect(result).toContain('Submit button');
  });

  it('clicks then types into a visual desktop target', async () => {
    hoisted.takeDesktopScreenshotMock.mockResolvedValueOnce({ path: '/tmp/shot2.png' });
    hoisted.analyzeImageMock.mockResolvedValueOnce('{"x": 111, "y": 222}');
    hoisted.desktopClickMock.mockResolvedValueOnce('Clicked desktop at (111, 222)');
    hoisted.desktopTypeTextMock.mockResolvedValueOnce('Typed 5 characters into the desktop');

    const result = await typeIntoDesktopTarget({
      target: 'Search field',
      text: 'hello',
      tenantId: 'default',
    });

    expect(hoisted.desktopClickMock).toHaveBeenCalledWith(expect.objectContaining({ x: 111, y: 222 }));
    expect(hoisted.desktopTypeTextMock).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
    expect(result).toContain('Search field');
  });

  it('throws when vision output cannot be parsed', async () => {
    hoisted.takeDesktopScreenshotMock.mockResolvedValueOnce({ path: '/tmp/shot3.png' });
    hoisted.analyzeImageMock.mockResolvedValueOnce('no coords here');

    await expect(clickDesktopTarget({ target: 'Unknown control' })).rejects.toThrow('could not parse coordinates');
  });
});
