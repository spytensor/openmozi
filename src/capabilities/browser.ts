import type { Browser, BrowserContext, Page } from 'playwright';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import pino from 'pino';
import { analyzeImage } from './vision.js';
import { createApprovalRequest, formatApprovalNotification, getRequest } from '../security/gates.js';
import { getConfig } from '../config/index.js';
import { checkSSRF } from '../security/ssrf-guard.js';

const logger = pino({ name: 'mozi:capability:browser' });

interface BrowserSession {
  id: string;
  tenantId: string;
  browser: Browser;
  context: BrowserContext;
  page: Page;
  createdAt: number;
  lastUsedAt: number;
}

const sessions = new Map<string, BrowserSession>();
const SESSION_IDLE_MS = 15 * 60 * 1000;
type PlaywrightModule = typeof import('playwright');
let playwrightModulePromise: Promise<PlaywrightModule> | null = null;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (playwrightModulePromise) {
    return playwrightModulePromise;
  }

  // Use runtime import to avoid bundling Playwright internals into dist.
  const moduleName = 'playwright';
  playwrightModulePromise = import(moduleName).catch((err: unknown) => {
    playwrightModulePromise = null;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error([
      'Playwright is required for browser_* tools but is unavailable.',
      'Install it with `pnpm add playwright` and run `npx playwright install`.',
      `Original error: ${detail}`,
    ].join(' '));
  });
  return playwrightModulePromise;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.lastUsedAt <= SESSION_IDLE_MS) continue;
    void closeSession(sessionId).catch((err) => {
      logger.warn({
        sessionId,
        err: err instanceof Error ? err.message : String(err),
      }, 'Failed to close idle browser session');
    });
  }
}, 60_000);
cleanupTimer.unref();

function makeSessionId(): string {
  return `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function checkBrowserRequest(url: string): Promise<{ safe: boolean; reason?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { safe: false, reason: `Invalid URL: ${url}` };
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') {
    return { safe: true };
  }
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  return checkSSRF(parsed.toString());
}

function getSession(sessionId: string, tenantId: string): BrowserSession {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error(`Browser session not found: ${sessionId}`);
  }
  if (session.tenantId !== tenantId) {
    throw new Error(`Browser session "${sessionId}" belongs to a different tenant`);
  }
  session.lastUsedAt = Date.now();
  return session;
}

function isHighRiskAction(
  action: 'click' | 'type',
  pageUrl: string,
  selector: string,
  hint: string,
  text: string,
): boolean {
  const urlRisk = /(checkout|payment|wallet|bank|transfer|security|admin|billing)/i;
  const actionRisk = /(delete|remove|transfer|purchase|pay|wire|terminate|reset|withdraw|revoke|disable|close[_-\s]?account)/i;
  const confirmRisk = /(confirm|submit|approve|authorize)/i;
  if (urlRisk.test(pageUrl)) return true;
  if (actionRisk.test(selector)) return true;
  if (actionRisk.test(hint)) return true;
  if (action === 'type' && actionRisk.test(text)) return true;
  if (urlRisk.test(pageUrl) && (confirmRisk.test(selector) || confirmRisk.test(hint))) return true;
  if (action === 'type' && urlRisk.test(pageUrl) && confirmRisk.test(text)) return true;
  return false;
}

function enforceApprovalIfNeeded(params: {
  action: 'click' | 'type';
  tenantId: string;
  pageUrl: string;
  selector?: string;
  hint?: string;
  text?: string;
  approvalRequestId?: string;
}): void {
  const selector = params.selector ?? '';
  const hint = params.hint ?? '';
  const text = params.text ?? '';
  const risky = isHighRiskAction(params.action, params.pageUrl, selector, hint, text);
  if (!risky) return;

  // Respect config: skip approval if external_comm is not in hard_gates
  const hardGates = getConfig().security.hard_gates ?? [];
  if (!hardGates.includes('external_comm')) return;

  const requestId = params.approvalRequestId?.trim();
  if (requestId) {
    const req = getRequest(requestId, params.tenantId);
    if (!req) {
      throw new Error(`Approval request not found: ${requestId}`);
    }
    if (req.status !== 'approved') {
      throw new Error(`Approval request ${requestId} is ${req.status}. Use /approve ${requestId} first.`);
    }
    return;
  }

  const req = createApprovalRequest(
    'external_comm',
    `Browser ${params.action} requires approval on ${params.pageUrl}`,
    {
      action: params.action,
      url: params.pageUrl,
      selector,
      hint,
      text_preview: text.slice(0, 120),
    },
    'browser_tool',
    params.tenantId,
  );
  throw new Error(formatApprovalNotification(req));
}

function parseCoordinates(raw: string): { x: number; y: number } {
  const fenced = raw.match(/\{[\s\S]*?\}/);
  if (fenced) {
    try {
      const parsed = JSON.parse(fenced[0]) as { x?: unknown; y?: unknown };
      if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
        return { x: parsed.x, y: parsed.y };
      }
    } catch {
      // fallback parser below
    }
  }

  const xMatch = raw.match(/["']?x["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  const yMatch = raw.match(/["']?y["']?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
  if (xMatch && yMatch) {
    return { x: Number(xMatch[1]), y: Number(yMatch[1]) };
  }

  throw new Error(`Visual fallback could not parse coordinates: ${raw.slice(0, 200)}`);
}

async function clickWithVisionFallback(page: Page, hint: string): Promise<{ x: number; y: number }> {
  const shotPath = join(tmpdir(), `mozi-browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`);
  try {
    await page.screenshot({ path: shotPath, fullPage: true });
    const analysis = await analyzeImage(
      shotPath,
      [
        'Identify the center coordinates of this target in the screenshot.',
        `Target: ${hint}`,
        'Respond with JSON only: {"x": <number>, "y": <number>}',
      ].join('\n'),
    );
    const coords = parseCoordinates(analysis);
    await page.mouse.click(coords.x, coords.y);
    return coords;
  } finally {
    if (existsSync(shotPath)) {
      try {
        unlinkSync(shotPath);
      } catch {
        // ignore temp cleanup failure
      }
    }
  }
}

export interface BrowserOpenOptions {
  url: string;
  tenantId?: string;
  headless?: boolean;
  timeoutMs?: number;
}

export async function openSession(options: BrowserOpenOptions): Promise<{
  sessionId: string;
  url: string;
  title: string;
}> {
  const tenantId = options.tenantId ?? 'default';
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({
    headless: options.headless ?? true,
  });
  let context: BrowserContext | undefined;
  let blockedNavigation: { url: string; reason: string } | undefined;
  try {
    context = await browser.newContext();
    await context.route('**/*', async (route) => {
      const request = route.request();
      const requestUrl = request.url();
      const check = await checkBrowserRequest(requestUrl);
      if (!check.safe) {
        const reason = check.reason ?? 'blocked by SSRF policy';
        if (request.isNavigationRequest()) blockedNavigation = { url: requestUrl, reason };
        logger.warn({ url: requestUrl, reason, resourceType: request.resourceType() }, 'Browser request blocked by SSRF policy');
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    await context.routeWebSocket('**/*', async (route) => {
      const requestUrl = route.url();
      const check = await checkBrowserRequest(requestUrl);
      if (!check.safe) {
        const reason = check.reason ?? 'blocked by SSRF policy';
        logger.warn({ url: requestUrl, reason }, 'Browser WebSocket blocked by SSRF policy');
        await route.close({ code: 1008, reason: 'Blocked by SSRF policy' });
        return;
      }
      route.connectToServer();
    });

    const page = await context.newPage();
    const timeout = options.timeoutMs ?? 30_000;
    try {
      await page.goto(options.url, { timeout, waitUntil: 'domcontentloaded' });
    } catch (err) {
      if (blockedNavigation) {
        throw new Error(`Browser navigation blocked by SSRF protection: ${blockedNavigation.reason} (${blockedNavigation.url})`);
      }
      throw err;
    }

    const sessionId = makeSessionId();
    sessions.set(sessionId, {
      id: sessionId,
      tenantId,
      browser,
      context,
      page,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    });

    return {
      sessionId,
      url: page.url(),
      title: await page.title(),
    };
  } catch (err) {
    await context?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw err;
  }
}

export interface BrowserClickOptions {
  sessionId: string;
  selector?: string;
  hint?: string;
  tenantId?: string;
  timeoutMs?: number;
  approvalRequestId?: string;
}

export async function click(options: BrowserClickOptions): Promise<string> {
  const tenantId = options.tenantId ?? 'default';
  const timeout = options.timeoutMs ?? 10_000;
  const session = getSession(options.sessionId, tenantId);
  const page = session.page;
  const selector = options.selector?.trim() ?? '';
  const hint = options.hint?.trim() ?? '';

  enforceApprovalIfNeeded({
    action: 'click',
    tenantId,
    pageUrl: page.url(),
    selector,
    hint,
    approvalRequestId: options.approvalRequestId,
  });

  try {
    if (selector) {
      await page.locator(selector).first().click({ timeout });
      return `Clicked selector: ${selector}`;
    }
    if (hint) {
      await page.getByText(hint, { exact: false }).first().click({ timeout });
      return `Clicked element with text: ${hint}`;
    }
    throw new Error('Either selector or hint is required for browser_click');
  } catch (err) {
    if (!hint) throw err;
    const coords = await clickWithVisionFallback(page, hint);
    return `Clicked via visual fallback at (${Math.round(coords.x)}, ${Math.round(coords.y)})`;
  }
}

export interface BrowserTypeOptions {
  sessionId: string;
  text: string;
  selector?: string;
  hint?: string;
  clear?: boolean;
  pressEnter?: boolean;
  tenantId?: string;
  timeoutMs?: number;
  approvalRequestId?: string;
}

export async function type(options: BrowserTypeOptions): Promise<string> {
  const tenantId = options.tenantId ?? 'default';
  const timeout = options.timeoutMs ?? 10_000;
  const session = getSession(options.sessionId, tenantId);
  const page = session.page;
  const selector = options.selector?.trim() ?? '';
  const hint = options.hint?.trim() ?? '';

  enforceApprovalIfNeeded({
    action: 'type',
    tenantId,
    pageUrl: page.url(),
    selector,
    hint,
    text: options.text,
    approvalRequestId: options.approvalRequestId,
  });

  try {
    if (selector) {
      const loc = page.locator(selector).first();
      if (options.clear ?? true) {
        await loc.fill('', { timeout });
      }
      await loc.fill(options.text, { timeout });
    } else if (hint) {
      const target = page.getByText(hint, { exact: false }).first();
      await target.click({ timeout });
      await page.keyboard.type(options.text);
    } else {
      throw new Error('Either selector or hint is required for browser_type');
    }
  } catch (err) {
    if (!hint) throw err;
    const coords = await clickWithVisionFallback(page, hint);
    await page.keyboard.type(options.text);
    logger.info({ sessionId: session.id, coords }, 'Typed via visual fallback');
  }

  if (options.pressEnter) {
    await page.keyboard.press('Enter');
  }
  return `Typed ${options.text.length} characters`;
}

export interface BrowserExtractOptions {
  sessionId: string;
  selector?: string;
  attribute?: string;
  maxChars?: number;
  tenantId?: string;
}

export async function extract(options: BrowserExtractOptions): Promise<string> {
  const tenantId = options.tenantId ?? 'default';
  const session = getSession(options.sessionId, tenantId);
  const page = session.page;
  const maxChars = options.maxChars ?? 10_000;

  let result = '';
  if (options.selector?.trim()) {
    const loc = page.locator(options.selector.trim()).first();
    if (options.attribute?.trim()) {
      result = await loc.getAttribute(options.attribute.trim()) ?? '';
    } else {
      result = await loc.innerText();
    }
  } else {
    result = await page.locator('body').innerText();
  }

  if (result.length > maxChars) {
    return result.slice(0, maxChars);
  }
  return result;
}

export interface BrowserAssertOptions {
  sessionId: string;
  assertion: 'contains_text' | 'url_matches' | 'selector_exists';
  value?: string;
  selector?: string;
  tenantId?: string;
}

export async function assert(options: BrowserAssertOptions): Promise<{ passed: boolean; detail: string }> {
  const tenantId = options.tenantId ?? 'default';
  const session = getSession(options.sessionId, tenantId);
  const page = session.page;

  if (options.assertion === 'url_matches') {
    const pattern = options.value ?? '';
    const passed = new RegExp(pattern).test(page.url());
    return {
      passed,
      detail: passed
        ? `URL matches /${pattern}/`
        : `URL "${page.url()}" does not match /${pattern}/`,
    };
  }

  if (options.assertion === 'selector_exists') {
    if (!options.selector) {
      throw new Error('selector is required for selector_exists assertion');
    }
    const count = await page.locator(options.selector).count();
    const passed = count > 0;
    return {
      passed,
      detail: passed
        ? `Selector exists: ${options.selector}`
        : `Selector not found: ${options.selector}`,
    };
  }

  const expected = options.value ?? '';
  const text = options.selector
    ? await page.locator(options.selector).first().innerText()
    : await page.locator('body').innerText();
  const passed = text.includes(expected);
  return {
    passed,
    detail: passed
      ? `Text found: ${expected}`
      : `Text not found: ${expected}`,
  };
}

export async function closeSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  await session.browser.close().catch(() => {});
}

export async function closeAllSessions(): Promise<void> {
  const ids = [...sessions.keys()];
  await Promise.all(ids.map(id => closeSession(id)));
}

export function listSessions(tenantId?: string): Array<{ sessionId: string; url: string; createdAt: number; lastUsedAt: number }> {
  const effectiveTenantId = tenantId ?? 'default';
  return [...sessions.values()]
    .filter(session => session.tenantId === effectiveTenantId)
    .map(session => ({
      sessionId: session.id,
      url: session.page.url(),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
    }));
}
