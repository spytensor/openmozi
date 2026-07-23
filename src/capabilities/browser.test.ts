import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const state = {
    pageUrl: 'about:blank',
    pageTitle: 'Mock Page',
    failSelectors: new Set<string>(),
    innerTexts: new Map<string, string>(),
    attributes: new Map<string, string>(),
    counts: new Map<string, number>(),
    mouseClicks: [] as Array<{ x: number; y: number }>,
    typed: [] as string[],
    routeHandler: undefined as ((route: any) => Promise<void>) | undefined,
    webSocketRouteHandler: undefined as ((route: any) => Promise<void>) | undefined,
    navigationRequestUrl: undefined as string | undefined,
  };

  const locatorFor = (selector: string) => ({
    first() {
      return this;
    },
    click: vi.fn(async () => {
      if (state.failSelectors.has(selector)) {
        throw new Error(`Selector failed: ${selector}`);
      }
    }),
    fill: vi.fn(async (value: string) => {
      if (state.failSelectors.has(selector)) {
        throw new Error(`Selector failed: ${selector}`);
      }
      state.typed.push(value);
    }),
    innerText: vi.fn(async () => state.innerTexts.get(selector) ?? ''),
    getAttribute: vi.fn(async (attr: string) => state.attributes.get(`${selector}:${attr}`) ?? null),
    count: vi.fn(async () => state.counts.get(selector) ?? 0),
  });

  const page = {
    goto: vi.fn(async (url: string) => {
      state.pageUrl = url;
      if (state.navigationRequestUrl && state.routeHandler) {
        let aborted = false;
        await state.routeHandler({
          request: () => ({
            url: () => state.navigationRequestUrl,
            isNavigationRequest: () => true,
            resourceType: () => 'document',
          }),
          abort: vi.fn(async () => { aborted = true; }),
          continue: vi.fn(async () => {}),
        });
        if (aborted) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      }
    }),
    url: vi.fn(() => state.pageUrl),
    title: vi.fn(async () => state.pageTitle),
    locator: vi.fn((selector: string) => locatorFor(selector)),
    getByText: vi.fn((text: string) => locatorFor(`text=${text}`)),
    screenshot: vi.fn(async () => {}),
    mouse: {
      click: vi.fn(async (x: number, y: number) => {
        state.mouseClicks.push({ x, y });
      }),
    },
    keyboard: {
      type: vi.fn(async (text: string) => {
        state.typed.push(text);
      }),
      press: vi.fn(async () => {}),
    },
  };

  const context = {
    route: vi.fn(async (_pattern: string, handler: (route: any) => Promise<void>) => {
      state.routeHandler = handler;
    }),
    routeWebSocket: vi.fn(async (_pattern: string, handler: (route: any) => Promise<void>) => {
      state.webSocketRouteHandler = handler;
    }),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {}),
  };

  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  };

  return {
    state,
    page,
    context,
    browser,
    launchMock: vi.fn(async () => browser),
    analyzeImageMock: vi.fn(async () => '{"x": 320, "y": 180}'),
    createApprovalRequestMock: vi.fn(() => ({ id: 'approval-1' })),
    formatApprovalNotificationMock: vi.fn(() => '[APPROVAL NEEDED] ID: approval-1 Use /approve approval-1'),
    getRequestMock: vi.fn(() => ({ id: 'approval-1', status: 'approved' })),
    mockHardGates: [] as string[],
  };
});

vi.mock('playwright', () => ({
  chromium: {
    launch: hoisted.launchMock,
  },
}));

vi.mock('./vision.js', () => ({
  analyzeImage: hoisted.analyzeImageMock,
}));

vi.mock('../security/gates.js', () => ({
  createApprovalRequest: hoisted.createApprovalRequestMock,
  formatApprovalNotification: hoisted.formatApprovalNotificationMock,
  getRequest: hoisted.getRequestMock,
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    security: { hard_gates: hoisted.mockHardGates },
  }),
}));

import {
  openSession,
  click,
  type,
  extract,
  assert,
  closeAllSessions,
} from './browser.js';

describe('capabilities/browser', () => {
  beforeEach(() => {
    hoisted.launchMock.mockClear();
    hoisted.page.goto.mockClear();
    hoisted.context.route.mockClear();
    hoisted.context.routeWebSocket.mockClear();
    hoisted.context.newPage.mockClear();
    hoisted.context.close.mockClear();
    hoisted.browser.newContext.mockClear();
    hoisted.browser.close.mockClear();
    hoisted.analyzeImageMock.mockClear();
    hoisted.createApprovalRequestMock.mockClear();
    hoisted.formatApprovalNotificationMock.mockClear();
    hoisted.getRequestMock.mockClear();
    hoisted.mockHardGates = [];
    hoisted.state.pageUrl = 'about:blank';
    hoisted.state.pageTitle = 'Mock Page';
    hoisted.state.failSelectors.clear();
    hoisted.state.innerTexts.clear();
    hoisted.state.attributes.clear();
    hoisted.state.counts.clear();
    hoisted.state.mouseClicks = [];
    hoisted.state.typed = [];
    hoisted.state.routeHandler = undefined;
    hoisted.state.webSocketRouteHandler = undefined;
    hoisted.state.navigationRequestUrl = undefined;
  });

  afterEach(async () => {
    await closeAllSessions();
  });

  it('opens a browser session and navigates to URL', async () => {
    const result = await openSession({
      url: 'https://example.com',
      tenantId: 'default',
    });

    expect(result.sessionId).toMatch(/^browser_/);
    expect(result.url).toBe('https://example.com');
    expect(hoisted.page.goto).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(hoisted.context.route).toHaveBeenCalledWith('**/*', expect.any(Function));
    expect(hoisted.context.routeWebSocket).toHaveBeenCalledWith('**/*', expect.any(Function));
  });

  it('blocks private subresource requests in the browser context', async () => {
    await openSession({ url: 'https://example.com' });
    const abort = vi.fn(async () => {});
    const continueRequest = vi.fn(async () => {});

    await hoisted.state.routeHandler?.({
      request: () => ({
        url: () => 'http://169.254.169.254/latest/meta-data',
        isNavigationRequest: () => false,
        resourceType: () => 'script',
      }),
      abort,
      continue: continueRequest,
    });

    expect(abort).toHaveBeenCalledWith('blockedbyclient');
    expect(continueRequest).not.toHaveBeenCalled();
  });

  it('blocks WebSocket connections to private services', async () => {
    await openSession({ url: 'https://example.com' });
    const close = vi.fn(async () => {});
    const connectToServer = vi.fn();

    await hoisted.state.webSocketRouteHandler?.({
      url: () => 'ws://127.0.0.1:6379/socket',
      close,
      connectToServer,
    });

    expect(close).toHaveBeenCalledWith({ code: 1008, reason: 'Blocked by SSRF policy' });
    expect(connectToServer).not.toHaveBeenCalled();
  });

  it('reports and cleans up a redirect navigation blocked by SSRF policy', async () => {
    hoisted.state.navigationRequestUrl = 'http://127.0.0.1/admin';

    await expect(openSession({ url: 'https://example.com' }))
      .rejects.toThrow('Browser navigation blocked by SSRF protection');
    expect(hoisted.context.close).toHaveBeenCalled();
    expect(hoisted.browser.close).toHaveBeenCalled();
  });

  it('clicks by selector when DOM locator succeeds', async () => {
    const session = await openSession({ url: 'https://example.com' });
    const result = await click({
      sessionId: session.sessionId,
      selector: '#login',
      tenantId: 'default',
    });

    expect(result).toContain('Clicked selector');
    expect(hoisted.page.locator).toHaveBeenCalledWith('#login');
  });

  it('falls back to visual click when DOM click fails', async () => {
    hoisted.state.failSelectors.add('#missing');

    const session = await openSession({ url: 'https://example.com' });
    const result = await click({
      sessionId: session.sessionId,
      selector: '#missing',
      hint: 'Submit',
      tenantId: 'default',
    });

    expect(hoisted.analyzeImageMock).toHaveBeenCalled();
    expect(hoisted.state.mouseClicks).toEqual([{ x: 320, y: 180 }]);
    expect(result).toContain('visual fallback');
  });

  it('allows high-risk actions without approval when hard_gates is empty (default)', async () => {
    const session = await openSession({ url: 'https://payments.example.com/checkout' });

    const result = await click({
      sessionId: session.sessionId,
      selector: '#confirm-payment',
      tenantId: 'default',
    });

    expect(result).toContain('Clicked selector');
    expect(hoisted.createApprovalRequestMock).not.toHaveBeenCalled();
  });

  it('requires approval for high-risk actions when external_comm is in hard_gates', async () => {
    hoisted.mockHardGates = ['external_comm'];

    const session = await openSession({ url: 'https://payments.example.com/checkout' });

    await expect(click({
      sessionId: session.sessionId,
      selector: '#confirm-payment',
      tenantId: 'default',
    })).rejects.toThrow('/approve');

    expect(hoisted.createApprovalRequestMock).toHaveBeenCalledOnce();
  });

  it('allows high-risk actions with approved request id and supports extract/assert/type', async () => {
    hoisted.mockHardGates = ['external_comm'];

    const session = await openSession({ url: 'https://payments.example.com/checkout' });
    hoisted.state.innerTexts.set('#summary', 'Order total: $99');
    hoisted.state.attributes.set('#summary:data-total', '99');
    hoisted.state.counts.set('#summary', 1);

    await click({
      sessionId: session.sessionId,
      selector: '#confirm-payment',
      approvalRequestId: 'approval-1',
      tenantId: 'default',
    });

    await type({
      sessionId: session.sessionId,
      selector: '#note',
      text: 'ship today',
      approvalRequestId: 'approval-1',
      tenantId: 'default',
    });

    const extracted = await extract({
      sessionId: session.sessionId,
      selector: '#summary',
      attribute: 'data-total',
      tenantId: 'default',
    });
    expect(extracted).toBe('99');

    const asserted = await assert({
      sessionId: session.sessionId,
      assertion: 'contains_text',
      selector: '#summary',
      value: '$99',
      tenantId: 'default',
    });
    expect(asserted.passed).toBe(true);
    expect(hoisted.getRequestMock).toHaveBeenCalledWith('approval-1', 'default');
  });
});
