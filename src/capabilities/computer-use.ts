import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeImage } from './vision.js';
import {
  desktopClick,
  desktopTypeText,
  takeDesktopScreenshot,
} from './desktop.js';

function parseCoordinates(raw: string): { x: number; y: number } {
  const fenced = raw.match(/\{[\s\S]*?\}/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[0]) as { x?: unknown; y?: unknown };
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return { x: parsed.x, y: parsed.y };
      }
    } catch {
      // fall through to regex parser
    }
  }

  const xMatch = raw.match(/["']?x["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const yMatch = raw.match(/["']?y["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (xMatch && yMatch) {
    return { x: Number(xMatch[1]), y: Number(yMatch[1]) };
  }

  throw new Error(`Computer-use vision could not parse coordinates: ${raw.slice(0, 200)}`);
}

async function locateTargetByVision(screenshotPath: string, target: string): Promise<{ x: number; y: number }> {
  const analysis = await analyzeImage(
    screenshotPath,
    [
      'Identify the center coordinates of this target in the screenshot.',
      `Target: ${target}`,
      'Respond with JSON only: {"x": <number>, "y": <number>}',
    ].join('\n'),
  );
  return parseCoordinates(analysis);
}

async function withDesktopScreenshot<T>(
  fn: (screenshotPath: string) => Promise<T>,
): Promise<T> {
  const screenshotPath = join(tmpdir(), `mozi-computer-use-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await takeDesktopScreenshot({ path: screenshotPath });
    return await fn(screenshotPath);
  } finally {
    if (existsSync(screenshotPath)) {
      try {
        unlinkSync(screenshotPath);
      } catch {
        // ignore cleanup failures
      }
    }
  }
}

export async function clickDesktopTarget(options: {
  target: string;
  tenantId?: string;
  approvalRequestId?: string;
}): Promise<string> {
  return withDesktopScreenshot(async (screenshotPath) => {
    const coords = await locateTargetByVision(screenshotPath, options.target);
    const result = await desktopClick({
      x: coords.x,
      y: coords.y,
      tenantId: options.tenantId,
      approvalRequestId: options.approvalRequestId,
    });
    return `${result} via visual target "${options.target}"`;
  });
}

export async function typeIntoDesktopTarget(options: {
  target: string;
  text: string;
  tenantId?: string;
  approvalRequestId?: string;
}): Promise<string> {
  return withDesktopScreenshot(async (screenshotPath) => {
    const coords = await locateTargetByVision(screenshotPath, options.target);
    await desktopClick({
      x: coords.x,
      y: coords.y,
      tenantId: options.tenantId,
      approvalRequestId: options.approvalRequestId,
    });
    const typed = await desktopTypeText({
      text: options.text,
      tenantId: options.tenantId,
      approvalRequestId: options.approvalRequestId,
    });
    return `${typed} via visual target "${options.target}"`;
  });
}
