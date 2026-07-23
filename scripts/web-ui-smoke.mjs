#!/usr/bin/env node
/**
 * Real browser smoke for the MOZI Web UI.
 *
 * Starts the built runtime with an isolated MOZI_HOME, opens the served UI in
 * Chromium, completes first-run onboarding when needed, and verifies the
 * Settings diagnostics panels against live runtime data.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const hasArg = (name) => args.includes(name);
const getArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const skipBuild = hasArg('--skip-build');
const keepHome = hasArg('--keep-home');
const debug = hasArg('--debug');
const headed = hasArg('--headed');
const readmeScreenshots = hasArg('--readme-screenshots');
const host = '127.0.0.1';
const requestedPort = Number(getArg('--port') ?? process.env.MOZI_WEB_SMOKE_PORT ?? 0);
const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : await getFreePort();
const baseUrl = `http://${host}:${port}`;

const outputDir = resolve('output', 'playwright');
const reportsDir = resolve('reports');
const diagnosticsLayoutScreenshotPath = join(outputDir, 'web-ui-diagnostics-layout.png');
const settingsLayoutScreenshotPath = join(outputDir, 'web-ui-settings-layout.png');
const chatSidebarScreenshotPath = join(outputDir, 'web-ui-chat-sidebar-contract.png');
const executionCollapsedScreenshotPath = join(outputDir, 'web-ui-execution-contract-collapsed.png');
const executionExpandedScreenshotPath = join(outputDir, 'web-ui-execution-contract-expanded.png');
const reportPath = join(reportsDir, 'web-ui-smoke.json');

mkdirSync(outputDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });

if (!existsSync(resolve('package.json'))) {
  fail('Run this script from the MOZI repository root.');
}

if (!skipBuild) {
  await run('pnpm', ['build:all']);
} else {
  assertBuiltRuntime();
}

const moziHome = mkdtempSync(join(tmpdir(), 'mozi-web-ui-smoke-'));
const workspaceDir = join(moziHome, 'workspace');
mkdirSync(workspaceDir, { recursive: true });
writeFileSync(join(moziHome, 'mozi.json'), `${JSON.stringify({
  server: { host, port, auth_mode: 'none' },
  brain: { model: 'gpt-4.1-mini' },
  model_router: { brain_provider: 'openai' },
  providers: { openai: { apikey: 'web-ui-smoke-key' } },
  telegram: { bot_token: '' },
  wechat: { bot_token: '' },
  workspace: { dir: workspaceDir },
  tools: {
    fs: {
      workspace_only: true,
      allow_project_root_read: true,
      additional_allowed_roots: [moziHome],
    },
    subagents: { enabled: false },
  },
}, null, 2)}\n`);

let server;
let browser;
const pageErrors = [];
const apiFailures = [];
const resourceFailures = [];
const observedRuntimeEndpoints = new Set();
const startedAt = Date.now();

try {
  server = startRuntime({ moziHome, port });
  const health = await waitForHealth(server, moziHome);

  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  await installWebSocketProbe(page);
  await page.addInitScript(() => {
    localStorage.setItem('mozi:diagnostics', '1');
  });
  page.on('pageerror', (err) => {
    if (!isIgnorablePageError(err.message)) pageErrors.push(err.message);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableBrowserResourceConsole(message)) {
      pageErrors.push(message.text());
    }
    if (debug) console.error(`[browser:${message.type()}] ${message.text()}`);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (url.includes('/api/runtime/')) {
      observedRuntimeEndpoints.add(new URL(url).pathname);
    }
    if (url.startsWith(`${baseUrl}/api/`) && response.status() >= 400) {
      apiFailures.push(`${response.status()} ${url}`);
    } else if (url.startsWith(`${baseUrl}/`) && response.status() >= 400 && !isOptionalBrowserResource(response)) {
      resourceFailures.push(`${response.status()} ${url}`);
    }
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await completeOnboardingIfNeeded(page);
  if (readmeScreenshots) await captureReadmeScreenshots(page);
  const sidebarContract = await verifyChatFirstSidebarContract(page);
  const executionContract = await verifyExecutionDisplayContract(page, sidebarContract.reusable_draft_session_id);
  const paneScrollContract = await verifyPaneScrollContract(page);

  await clickAccountMenuItem(page, 'Settings');
  await page.getByRole('heading', { name: 'Settings' }).waitFor({ timeout: 10_000 });
  const settingsLayoutContract = await verifySettingsLayoutContract(page);
  const diagnosticsContract = await verifySettingsDiagnosticsContract(page);
  await page.screenshot({ path: settingsLayoutScreenshotPath, fullPage: true });

  const runtimeSnapshot = await page.evaluate(async () => {
    const response = await fetch('/api/runtime/workspace', { credentials: 'include' });
    if (!response.ok) throw new Error(`workspace status ${response.status}`);
    return response.json();
  });
  const serviceStatus = await page.evaluate(async () => {
    const response = await fetch('/api/runtime/service', { credentials: 'include' });
    if (!response.ok) throw new Error(`service status ${response.status}`);
    return response.json();
  });

  assertEqual(runtimeSnapshot.mozi_home.path, moziHome, 'Browser runtime snapshot should use isolated MOZI_HOME');
  assertEqual(runtimeSnapshot.config.server.auth_mode, 'none', 'Browser runtime snapshot should expose auth_mode=none');
  if (!['linux', 'darwin', 'unsupported'].includes(serviceStatus.platform)) {
    fail(`Unexpected runtime service platform: ${serviceStatus.platform}`);
  }
  if (apiFailures.length > 0) {
    fail(`API failures observed in browser: ${apiFailures.join('; ')}`);
  }
  if (resourceFailures.length > 0) {
    fail(`Resource failures observed in browser: ${resourceFailures.join('; ')}`);
  }
  if (pageErrors.length > 0) {
    fail(`Browser console/page errors observed: ${pageErrors.join('; ')}`);
  }

  const report = {
    ok: true,
    base_url: baseUrl,
    mozi_home: moziHome,
    health,
    runtime_snapshot: {
      mozi_home: runtimeSnapshot.mozi_home,
      config: runtimeSnapshot.config,
      counts: runtimeSnapshot.counts,
    },
    service_status: serviceStatus,
    sidebar_contract: sidebarContract,
    execution_contract: executionContract,
    pane_scroll_contract: paneScrollContract,
    settings_layout_contract: settingsLayoutContract,
    diagnostics_contract: diagnosticsContract,
    observed_runtime_endpoints: Array.from(observedRuntimeEndpoints).sort(),
    screenshots: {
      diagnostics_layout: diagnosticsLayoutScreenshotPath,
      settings_layout: settingsLayoutScreenshotPath,
      chat_sidebar_contract: chatSidebarScreenshotPath,
      execution_contract_collapsed: executionCollapsedScreenshotPath,
      execution_contract_expanded: executionExpandedScreenshotPath,
    },
    duration_ms: Date.now() - startedAt,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS web-ui-smoke ${baseUrl}`);
  console.log(`Report: ${reportPath}`);
  console.log(`Diagnostics screenshot: ${diagnosticsLayoutScreenshotPath}`);
  console.log(`Settings screenshot: ${settingsLayoutScreenshotPath}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) await stopRuntime(server);
  if (!keepHome) rmSync(moziHome, { recursive: true, force: true });
}

function assertBuiltRuntime() {
  if (!existsSync(resolve('dist', 'index.js'))) {
    fail('Missing dist/index.js. Run `pnpm build:all` or omit --skip-build.');
  }
  if (!existsSync(resolve('ui', 'dist', 'index.html'))) {
    fail('Missing ui/dist/index.html. Run `pnpm build:all` or omit --skip-build.');
  }
}

function isIgnorableBrowserResourceConsole(message) {
  return message.text() === 'Failed to load resource: the server responded with a status of 404 ()';
}

function isIgnorablePageError(message) {
  return message === "Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.";
}

function isOptionalBrowserResource(response) {
  const pathname = new URL(response.url()).pathname;
  return response.status() === 404 && [
    '/favicon.ico',
    '/apple-touch-icon.png',
    '/apple-touch-icon-precomposed.png',
  ].includes(pathname);
}

async function completeOnboardingIfNeeded(page) {
  const welcome = page.getByRole('heading', { name: /Welcome to (MOZI|your agent runtime)/ });
  const isOnboarding = await welcome.waitFor({ timeout: 15_000 }).then(() => true).catch(() => false);
  if (!isOnboarding) return;

  await page.getByLabel('Display name').fill(readmeScreenshots ? 'Demo User' : 'Local User');
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByRole('button', { name: /Skip/ }).click();
  await page.getByRole('button', { name: /Skip/ }).click();
  await page.getByRole('button', { name: /Get Started/ }).click();
}

async function captureReadmeScreenshots(page) {
  const screenshotDir = resolve('docs', 'assets', 'readme');
  mkdirSync(screenshotDir, { recursive: true });

  for (const locale of ['en', 'zh-CN']) {
    await page.evaluate((nextLocale) => {
      localStorage.setItem('mozi.ui.locale', nextLocale);
      localStorage.setItem('mozi.ui.theme', 'dark');
    }, locale);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.getByTestId('composer').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'), { timeout: 10_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const contextTrigger = page.getByRole('button', {
      name: locale === 'en' ? /Runtime Source|Choose project/ : /运行时源码|选择项目/,
    }).first();
    if (await contextTrigger.isVisible().catch(() => false)) {
      await contextTrigger.click();
      const generalTask = page.getByText(locale === 'en' ? 'General task' : '普通任务', { exact: true });
      if (await generalTask.isVisible().catch(() => false)) await generalTask.click();
    }
    await page.waitForTimeout(1_000);
    await page.screenshot({
      path: join(screenshotDir, locale === 'en' ? 'home.en.png' : 'home.zh-CN.png'),
      fullPage: false,
    });

    await page.waitForFunction(() => window.__moziWebUiSmoke?.openSocketCount?.() > 0, { timeout: 30_000 });
    await page.evaluate((nextLocale) => {
      const isChinese = nextLocale === 'zh-CN';
      const turnId = `turn-readme-${nextLocale}`;
      const now = Date.now();
      const dispatch = window.__moziWebUiSmoke.dispatch;
      dispatch({
        type: 'message',
        role: 'user',
        content: isChinese
          ? '整理这份产品数据，做一个可以直接汇报的交互式 Dashboard。'
          : 'Turn this product data into an interactive dashboard I can present.',
        turnId,
        seq: 0,
      });
      dispatch({
        type: 'turn_envelope',
        turn: {
          turnId,
          sessionId: `readme-${nextLocale}`,
          chatId: `readme-${nextLocale}`,
          origin: 'user',
          status: 'completed',
          seqHighWater: 3,
          locale: nextLocale,
          startedAt: now - 72_000,
          endedAt: now,
        },
      });
      dispatch({
        type: 'artifact_open',
        turnId,
        seq: 1,
        artifact: {
          id: `artifact-readme-${nextLocale}`,
          plugin_id: 'sandpack_v1',
          title: isChinese ? '产品增长 Dashboard' : 'Product growth dashboard',
          status: 'completed',
          data: {
            template: 'static',
            entry: '/index.html',
            files: {
              '/index.html': '<!doctype html><html><body><main><h1>OpenMozi</h1><p>Safe synthetic demo</p></main></body></html>',
            },
          },
        },
      });
      dispatch({
        type: 'message',
        role: 'assistant',
        content: isChinese
          ? '完成。我核对了数据口径，并生成了一份可直接打开的交互式 Dashboard。'
          : 'Done. I checked the metrics and generated an interactive dashboard you can open directly.',
        turnId,
        seq: 2,
      });
      dispatch({ type: 'active_turn', turnId: null, sessionId: `readme-${nextLocale}` });
    }, locale);

    await page.getByText(locale === 'en' ? 'Product growth dashboard' : '产品增长 Dashboard').waitFor({ timeout: 10_000 });
    await page.screenshot({
      path: join(screenshotDir, locale === 'en' ? 'run.en.png' : 'run.zh-CN.png'),
      fullPage: false,
    });
  }

  await page.evaluate(() => localStorage.setItem('mozi.ui.locale', 'en'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.getByTestId('composer').waitFor({ timeout: 15_000 });
}

async function verifyChatFirstSidebarContract(page) {
  await page.locator('aside').waitFor({ timeout: 30_000 });
  const title = `Smoke history ${Date.now()}`;

  const created = await page.evaluate(async (sessionTitle) => {
    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ title: sessionTitle }),
    });
    if (!response.ok) {
      throw new Error(`session create status ${response.status}`);
    }
    return response.json();
  }, title);

  if (!created?.session?.id) {
    fail('Session create response did not include a session id');
  }
  if (!/^sess-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(created.session.id)) {
    fail(`Session id should be UUID-backed: ${created.session.id}`);
  }
  if (!String(created.session.updated_at ?? '').endsWith('Z')) {
    fail(`Session timestamps should be ISO UTC strings: ${JSON.stringify(created.session)}`);
  }

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('aside').waitFor({ timeout: 30_000 });
  await page.getByTestId('new-chat-command').waitFor({ timeout: 10_000 });
  await page.getByText(title).waitFor({ timeout: 10_000 });
  await page.mouse.move(900, 500);

  const sidebarState = await page.evaluate(() => {
    const sidebar = document.querySelector('aside');
    const buttonText = Array.from(document.querySelectorAll('aside button')).map((button) => button.textContent ?? '');
    return {
      has_new_chat: buttonText.some((text) => /new chat/i.test(text)),
      has_scheduled: buttonText.some((text) => /scheduled/i.test(text)),
      has_skills: buttonText.some((text) => /^skills/i.test(text.trim())),
      has_files: buttonText.some((text) => /^files/i.test(text.trim())),
      has_new_task: buttonText.some((text) => text.includes('New Task')),
      has_recent_work: buttonText.some((text) => text.includes('Recent Work')),
      has_projects: sidebar?.textContent?.includes('Projects') ?? false,
      has_raw_chats_label: sidebar?.textContent?.includes('C H A T S') ?? false,
      has_raw_projects_label: sidebar?.textContent?.includes('P R O J E C T S') ?? false,
    };
  });
  if (!sidebarState.has_new_chat || !sidebarState.has_scheduled || !sidebarState.has_skills || !sidebarState.has_files) {
    fail(`Sidebar should expose the current New chat, Scheduled, Skills, and Files navigation: ${JSON.stringify(sidebarState)}`);
  }
  if (sidebarState.has_new_task || sidebarState.has_recent_work) {
    fail(`Sidebar should not expose old New Task / Recent Work wording: ${JSON.stringify(sidebarState)}`);
  }
  if (sidebarState.has_raw_chats_label || sidebarState.has_raw_projects_label) {
    fail(`Sidebar section labels should be polished, not spaced all-caps: ${JSON.stringify(sidebarState)}`);
  }

  const sidebarFooterState = await page.evaluate(() => {
    const accountTrigger = document.querySelector('[data-testid="account-row"]');
    const footer = accountTrigger?.parentElement ?? null;
    const sectionButtons = Array.from(document.querySelectorAll('[data-testid="sidebar-scroll-region"] section > button')).map((button) => button.textContent?.trim() ?? '');
    return {
      footer_text: footer?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
      section_button_text: sectionButtons,
      account_trigger: Boolean(accountTrigger),
      has_persistent_logout: Array.from(footer?.querySelectorAll('button') ?? []).some((button) => /^log\s*out$/i.test(button.textContent?.trim() ?? '')),
      has_persistent_settings: Array.from(footer?.querySelectorAll('button') ?? []).some((button) => /^settings$/i.test(button.textContent?.trim() ?? '')),
    };
  });
  if (sidebarFooterState.footer_text.includes('active ·') || /\bconnected\b/i.test(sidebarFooterState.footer_text) || /gpt|deepseek|claude/i.test(sidebarFooterState.footer_text)) {
    fail(`Sidebar footer should not expose runtime/model noise: ${JSON.stringify(sidebarFooterState)}`);
  }
  if (sidebarFooterState.section_button_text.some((text) => /\d/.test(text))) {
    fail(`Sidebar section headers should not show count badges: ${JSON.stringify(sidebarFooterState)}`);
  }
  if (!sidebarFooterState.account_trigger || sidebarFooterState.has_persistent_logout || sidebarFooterState.has_persistent_settings) {
    fail(`Sidebar should move account settings and logout behind the account menu: ${JSON.stringify(sidebarFooterState)}`);
  }
  await page.getByTestId('account-row').click();
  await page.getByRole('menuitem', { name: 'Settings' }).waitFor({ timeout: 10_000 });
  await page.getByRole('menuitem', { name: 'Log out' }).waitFor({ timeout: 10_000 });
  const accountMenuState = await page.evaluate(() => ({
    menu_items: Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
  }));
  if (accountMenuState.menu_items.includes('Profile')) {
    fail(`Account menu should not expose fake Profile navigation: ${JSON.stringify(accountMenuState)}`);
  }
  await page.keyboard.press('Escape');

  const layoutState = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const sidebarScroll = document.querySelector('[data-testid="sidebar-scroll-region"]');
    const main = document.querySelector('main');
    return {
      page_scroll_height: scrollingElement.scrollHeight,
      page_client_height: scrollingElement.clientHeight,
      main_overflow_y: main ? getComputedStyle(main).overflowY : null,
      sidebar_scroll_overflow_y: sidebarScroll ? getComputedStyle(sidebarScroll).overflowY : null,
    };
  });
  if (layoutState.page_scroll_height > layoutState.page_client_height + 1) {
    fail(`Root page should not scroll all workspace panes together: ${JSON.stringify(layoutState)}`);
  }
  if (layoutState.main_overflow_y !== 'hidden') {
    fail(`Main workspace should own bounded child scroll regions: ${JSON.stringify(layoutState)}`);
  }
  if (layoutState.sidebar_scroll_overflow_y !== 'auto') {
    fail(`Sidebar content region should scroll independently: ${JSON.stringify(layoutState)}`);
  }

  await page.getByTestId('sidebar-search-input').fill('not-a-real-chat-title');
  await page.getByText('No chats found').waitFor({ timeout: 10_000 });
  await page.getByTestId('sidebar-search-input').fill(title);
  await page.getByText(title).waitFor({ timeout: 10_000 });
  await page.getByTestId('sidebar-search-input').fill('');
  await page.getByText(title).waitFor({ timeout: 10_000 });
  const projectRowsBeforeSearch = await page.locator('[data-sidebar-row-kind="project"]').count();
  if (projectRowsBeforeSearch !== 0) {
    fail(`Chat-only MVP should not render project rows: ${projectRowsBeforeSearch}`);
  }
  const projectCopyState = await page.evaluate(() => ({
    has_projects_header: Array.from(document.querySelectorAll('aside button')).some((button) => /^Projects/.test(button.textContent?.trim() ?? '')),
    has_no_projects_empty: document.body.textContent?.includes('No projects connected') ?? false,
    has_project_context_chip: document.body.textContent?.includes('General task') ?? false,
    has_attach_control: Boolean(document.querySelector('button[title="Attach"]')),
    has_mention_control: Boolean(document.querySelector('button[title="Mention"]')),
  }));
  if (
    projectCopyState.has_projects_header ||
    projectCopyState.has_no_projects_empty ||
    projectCopyState.has_project_context_chip ||
    projectCopyState.has_attach_control ||
    projectCopyState.has_mention_control
  ) {
    fail(`Chat-only MVP should hide project and unfinished composer controls: ${JSON.stringify(projectCopyState)}`);
  }

  const sessionsBeforeNewChat = await page.evaluate(async () => {
    const response = await fetch('/api/sessions', { credentials: 'include' });
    if (!response.ok) throw new Error(`session list status ${response.status}`);
    const data = await response.json();
    return {
      total: data.sessions.length,
      unusedDrafts: data.sessions.filter((session) => session.title === 'New Chat' && session.message_count === 0),
    };
  });
  const chatRowsBeforeNewChat = await page.locator('[data-sidebar-row-kind="chat"]').count();
  await page.getByTestId('new-chat-command').click();
  await page.waitForFunction(async (previous) => {
    const response = await fetch('/api/sessions', { credentials: 'include' });
    if (!response.ok) return false;
    const data = await response.json();
    const unusedDrafts = data.sessions.filter((session) => session.title === 'New Chat' && session.message_count === 0);
    return data.sessions.length === previous.total + 1 && unusedDrafts.length === 1;
  }, sessionsBeforeNewChat, { timeout: 10_000 });
  await page.getByTestId('composer').waitFor({ timeout: 10_000 });
  const afterFirstNewChat = await page.evaluate(() => {
    return {
      chat_rows: document.querySelectorAll('[data-sidebar-row-kind="chat"]').length,
      empty_new_chat_rows: Array.from(document.querySelectorAll('[data-sidebar-row-kind="chat"]')).filter((row) => {
        return row.textContent?.includes('New Chat');
      }).length,
      has_old_wording: document.body.textContent?.includes('Recent Work') || document.body.textContent?.includes('New Task'),
    };
  });
  if (afterFirstNewChat.chat_rows !== chatRowsBeforeNewChat || afterFirstNewChat.empty_new_chat_rows !== 0 || afterFirstNewChat.has_old_wording) {
    fail(`Unused New Chat drafts should not pollute chat history: ${JSON.stringify(afterFirstNewChat)}`);
  }
  const sessionsAfterFirstNewChat = await page.evaluate(async () => {
    const response = await fetch('/api/sessions', { credentials: 'include' });
    if (!response.ok) throw new Error(`session list status ${response.status}`);
    const data = await response.json();
    const unusedDrafts = data.sessions.filter((session) => session.title === 'New Chat' && session.message_count === 0);
    return { total: data.sessions.length, draftId: unusedDrafts[0]?.id ?? null, unusedDraftCount: unusedDrafts.length };
  });
  await page.getByTestId('new-chat-command').click();
  await page.waitForFunction(async (previous) => {
    const response = await fetch('/api/sessions', { credentials: 'include' });
    if (!response.ok) return false;
    const data = await response.json();
    const unusedDrafts = data.sessions.filter((session) => session.title === 'New Chat' && session.message_count === 0);
    return data.sessions.length === previous.total && unusedDrafts.length === 1 && unusedDrafts[0]?.id === previous.draftId;
  }, sessionsAfterFirstNewChat, { timeout: 10_000 });
  if (sessionsAfterFirstNewChat.unusedDraftCount !== 1) {
    fail(`New Chat should create exactly one reusable empty draft: ${JSON.stringify(sessionsAfterFirstNewChat)}`);
  }

  const emptyComposerState = await page.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const rect = composer?.getBoundingClientRect();
    return {
      variant: composer?.getAttribute('data-composer-variant'),
      rounded: composer ? getComputedStyle(composer.firstElementChild).borderRadius : null,
      top: rect?.top ?? null,
      bottom: rect?.bottom ?? null,
      bottom_gap: rect ? innerHeight - rect.bottom : null,
      viewport_height: innerHeight,
    };
  });
  if (
    emptyComposerState.variant !== 'empty' ||
    !emptyComposerState.rounded?.startsWith('20px') ||
    emptyComposerState.top == null ||
    emptyComposerState.top < 0 ||
    emptyComposerState.bottom_gap == null ||
    emptyComposerState.bottom_gap > 18
  ) {
    fail(`Empty composer should remain visible and dock at the bottom: ${JSON.stringify(emptyComposerState)}`);
  }

  await page.evaluate(() => {
    window.__moziWebUiSmoke.dispatch({ type: 'message', role: 'user', content: 'hello from smoke' });
  });
  await page.getByTestId('composer-dock').waitFor({ timeout: 10_000 });
  const dockedComposerState = await page.evaluate(() => {
    const dock = document.querySelector('[data-testid="composer-dock"]');
    const composer = document.querySelector('[data-testid="composer"]');
    const sidebar = document.querySelector('aside');
    const workspacePanel = document.querySelector('[data-testid="workspace-panel"]');
    const dockRect = dock?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const sidebarWidth = sidebar ? sidebar.getBoundingClientRect().width : 0;
    const workspaceWidth = workspacePanel ? workspacePanel.getBoundingClientRect().width : 0;
    const availableWidth = innerWidth - sidebarWidth - workspaceWidth - 40;
    const targetWidth = Math.min(availableWidth, 1240);
    return {
      variant: composer?.getAttribute('data-composer-variant'),
      dock_bottom_gap: dockRect ? innerHeight - dockRect.bottom : null,
      composer_width: composerRect?.width ?? null,
      composer_height: composerRect?.height ?? null,
      viewport_width: innerWidth,
      expected_comfort_width: targetWidth,
    };
  });
  if (dockedComposerState.variant !== 'active' || dockedComposerState.dock_bottom_gap == null || dockedComposerState.dock_bottom_gap > 18) {
    fail(`Active conversation composer should dock at the bottom: ${JSON.stringify(dockedComposerState)}`);
  }
  if (
    dockedComposerState.composer_width == null ||
    dockedComposerState.composer_width < dockedComposerState.expected_comfort_width - 32 ||
    dockedComposerState.composer_width > dockedComposerState.expected_comfort_width + 32
  ) {
    fail(`Active conversation composer should use a comfortable dock width: ${JSON.stringify(dockedComposerState)}`);
  }
  if (dockedComposerState.composer_height == null || dockedComposerState.composer_height > 116) {
    fail(`Active conversation composer should stay compact until the user writes more: ${JSON.stringify(dockedComposerState)}`);
  }
  await page.locator('[data-testid="composer"] textarea').fill('line one\nline two\nline three\nline four\nline five\nline six');
  await page.waitForFunction((previousHeight) => {
    const composer = document.querySelector('[data-testid="composer"]');
    const rect = composer?.getBoundingClientRect();
    return rect && rect.height > previousHeight + 32;
  }, dockedComposerState.composer_height, { timeout: 10_000 });
  const grownComposerState = await page.evaluate(() => {
    const composer = document.querySelector('[data-testid="composer"]');
    const textarea = document.querySelector('[data-testid="composer"] textarea');
    const composerRect = composer?.getBoundingClientRect();
    const textareaStyle = textarea ? getComputedStyle(textarea) : null;
    return {
      composer_height: composerRect?.height ?? null,
      textarea_height: textareaStyle?.height ?? null,
      textarea_overflow_y: textareaStyle?.overflowY ?? null,
    };
  });
  if (grownComposerState.composer_height == null || grownComposerState.composer_height > 180) {
    fail(`Active conversation composer should grow only to a bounded height: ${JSON.stringify(grownComposerState)}`);
  }
  await page.locator('[data-testid="composer"] textarea').fill('');

  await page.evaluate(() => {
    window.__moziWebUiSmoke.dispatch({ type: 'message', role: 'assistant', content: 'Smoke response is unframed.' });
  });
  await page.getByText('Smoke response is unframed.').waitFor({ timeout: 10_000 });
  const assistantFrameState = await page.evaluate(() => {
    const assistant = document.querySelector('[data-testid="message-assistant"]');
    const content = document.querySelector('[data-testid="message-assistant-content"]');
    const assistantStyle = assistant ? getComputedStyle(assistant) : null;
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      found: Boolean(assistant),
      content_found: Boolean(content),
      background: assistantStyle?.backgroundColor ?? null,
      border_top_width: assistantStyle?.borderTopWidth ?? null,
      border_radius: assistantStyle?.borderRadius ?? null,
      content_background: contentStyle?.backgroundColor ?? null,
      content_border_top_width: contentStyle?.borderTopWidth ?? null,
      content_border_radius: contentStyle?.borderRadius ?? null,
    };
  });
  if (
    !assistantFrameState.found ||
    !assistantFrameState.content_found ||
    assistantFrameState.background !== 'rgba(0, 0, 0, 0)' ||
    assistantFrameState.border_top_width !== '0px' ||
    assistantFrameState.border_radius !== '0px' ||
    assistantFrameState.content_background !== 'rgba(0, 0, 0, 0)' ||
    assistantFrameState.content_border_top_width !== '0px' ||
    assistantFrameState.content_border_radius !== '0px'
  ) {
    fail(`Assistant output should render directly on the workspace, not inside a frame: ${JSON.stringify(assistantFrameState)}`);
  }
  const readingRailState = await page.evaluate(() => {
    const sidebar = document.querySelector('aside');
    const rail = document.querySelector('[data-testid="chat-timeline-rail"]');
    const composer = document.querySelector('[data-testid="composer"]');
    const assistant = document.querySelector('[data-testid="message-assistant"]');
    const sidebarRect = sidebar?.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    const composerRect = composer?.getBoundingClientRect();
    const assistantRect = assistant?.getBoundingClientRect();
    return {
      sidebar_right: sidebarRect?.right ?? null,
      rail_left: railRect?.left ?? null,
      rail_width: railRect?.width ?? null,
      composer_left: composerRect?.left ?? null,
      composer_width: composerRect?.width ?? null,
      assistant_left: assistantRect?.left ?? null,
      assistant_width: assistantRect?.width ?? null,
      assistant_sidebar_gap: sidebarRect && assistantRect ? assistantRect.left - sidebarRect.right : null,
      rail_composer_left_delta: railRect && composerRect ? Math.abs(railRect.left - composerRect.left) : null,
    };
  });
  if (
    readingRailState.rail_left == null ||
    readingRailState.composer_left == null ||
    readingRailState.assistant_left == null ||
    readingRailState.assistant_sidebar_gap == null ||
    readingRailState.rail_composer_left_delta == null ||
    readingRailState.assistant_sidebar_gap < 104 ||
    readingRailState.rail_composer_left_delta > 36
  ) {
    fail(`Chat timeline should use a centered reading rail aligned with the composer: ${JSON.stringify(readingRailState)}`);
  }

  await page.screenshot({ path: chatSidebarScreenshotPath, fullPage: true });

  return {
    reload_reveals_chats: true,
    old_sidebar_wording_removed: true,
    sidebar_footer_noise_removed: true,
    sidebar_counts_removed: true,
    logout_moved_to_account_menu: true,
    sidebar_search_filters_chats: true,
    sidebar_search_filters_projects: false,
    projects_hidden_for_chat_mvp: true,
    composer_scope_controls_hidden: true,
    project_rows_seen: projectRowsBeforeSearch,
    chats_can_collapse: true,
    new_chat_reuses_empty_draft: true,
    new_chat_rows_before: chatRowsBeforeNewChat,
    new_chat_rows_after: afterFirstNewChat.chat_rows,
    reusable_draft_session_id: sessionsAfterFirstNewChat.draftId,
    empty_composer_variant: emptyComposerState.variant,
    active_composer_variant: dockedComposerState.variant,
    active_composer_width: dockedComposerState.composer_width,
    active_composer_height: dockedComposerState.composer_height,
    active_composer_grown_height: grownComposerState.composer_height,
    active_composer_expected_comfort_width: dockedComposerState.expected_comfort_width,
    assistant_output_unframed: true,
    chat_reading_rail_aligned: true,
    chat_reading_rail_left: readingRailState.rail_left,
    chat_assistant_sidebar_gap: readingRailState.assistant_sidebar_gap,
    root_page_scroll_locked: true,
    created_session_id: created.session.id,
    created_session_title: title,
  };
}

async function verifyPaneScrollContract(page) {
  await page.getByTestId('chat-scroll-region').waitFor({ timeout: 10_000 });

  const chatState = await page.evaluate(() => {
    const chatScroll = document.querySelector('[data-testid="chat-scroll-region"]');
    return {
      chat_scroll_overflow_y: chatScroll ? getComputedStyle(chatScroll).overflowY : null,
    };
  });

  if (chatState.chat_scroll_overflow_y !== 'auto') {
    fail(`Chat timeline should scroll independently: ${JSON.stringify(chatState)}`);
  }

  // Artifacts land as inline cards; the canvas opens only when the user clicks one.
  await page.evaluate(() => {
    window.__moziWebUiSmoke.dispatch({
      type: 'artifact_open',
      artifact: {
        id: 'artifact-scroll-contract',
        plugin_id: 'sandpack_v1',
        title: 'Scroll contract artifact',
        status: 'completed',
        data: {
          content_type: 'html',
          html: '<!doctype html><html><body><main style="height:200vh">Artifact</main></body></html>',
        },
      },
    });
  });
  await page.getByText('Scroll contract artifact').click();
  await page.getByTestId('artifact-panel').waitFor({ timeout: 10_000 });
  const artifactState = await page.evaluate(() => {
    const artifactPanel = document.querySelector('[data-testid="artifact-panel"]');
    const artifactPanelContent = document.querySelector('[data-testid="artifact-panel-content"]');
    return {
      artifact_panel_overflow_y: artifactPanel ? getComputedStyle(artifactPanel).overflowY : null,
      artifact_panel_content_overflow_y: artifactPanelContent ? getComputedStyle(artifactPanelContent).overflowY : null,
    };
  });
  if (artifactState.artifact_panel_overflow_y !== 'hidden') {
    fail(`Artifact panel shell should be height-bounded: ${JSON.stringify(artifactState)}`);
  }
  if (artifactState.artifact_panel_content_overflow_y !== 'hidden') {
    fail(`Artifact panel content frame should own its internal scroll: ${JSON.stringify(artifactState)}`);
  }

  await page.locator('[data-testid="artifact-panel"] button[title="Close"]').click();
  await page.getByTestId('artifact-panel').waitFor({ state: 'hidden', timeout: 10_000 });

  return {
    chat_scroll_region: 'auto',
    artifact_panel_shell: 'hidden',
    artifact_panel_content: 'hidden',
  };
}

async function verifyInspectScrollContract(page) {
  await page.getByTestId('inspect-scroll-region').waitFor({ timeout: 10_000 });
  const inspectState = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const inspectScroll = document.querySelector('[data-testid="inspect-scroll-region"]');
    return {
      page_scroll_height: scrollingElement.scrollHeight,
      page_client_height: scrollingElement.clientHeight,
      page_scroll_width: scrollingElement.scrollWidth,
      page_client_width: scrollingElement.clientWidth,
      inspect_scroll_width: inspectScroll?.scrollWidth ?? null,
      inspect_client_width: inspectScroll?.clientWidth ?? null,
      inspect_scroll_overflow_y: inspectScroll ? getComputedStyle(inspectScroll).overflowY : null,
      inspect_scroll_overflow_x: inspectScroll ? getComputedStyle(inspectScroll).overflowX : null,
    };
  });
  if (inspectState.page_scroll_height > inspectState.page_client_height + 1) {
    fail(`Inspect view should not make the root page scroll: ${JSON.stringify(inspectState)}`);
  }
  if (inspectState.page_scroll_width > inspectState.page_client_width + 1) {
    fail(`Inspect view should not make the root page horizontally scroll: ${JSON.stringify(inspectState)}`);
  }
  if (inspectState.inspect_scroll_width > inspectState.inspect_client_width + 1) {
    fail(`Inspect view should not horizontally overflow its own region: ${JSON.stringify(inspectState)}`);
  }
  if (inspectState.inspect_scroll_overflow_y !== 'auto') {
    fail(`Inspect view should scroll inside its own region: ${JSON.stringify(inspectState)}`);
  }
  if (inspectState.inspect_scroll_overflow_x !== 'hidden') {
    fail(`Inspect view should hide horizontal overflow: ${JSON.stringify(inspectState)}`);
  }
  return {
    inspect_scroll_region: 'auto',
    inspect_horizontal_overflow_hidden: true,
    root_page_scroll_locked: true,
  };
}

async function clickSidebarNav(page, label) {
  const navButton = page.locator('aside > div:last-child button').filter({ hasText: label });
  const count = await navButton.count();
  if (count !== 1) {
    fail(`Expected exactly one sidebar nav button for ${label}, got ${count}`);
  }
  await navButton.click();
}

async function clickAccountMenuItem(page, label) {
  const accountButton = page.getByTestId('account-row');
  const count = await accountButton.count();
  if (count !== 1) {
    fail(`Expected exactly one account menu trigger, got ${count}`);
  }
  await accountButton.click();
  const menuItem = page.getByRole('menuitem', { name: label });
  await menuItem.waitFor({ timeout: 10_000 });
  await menuItem.click();
}

async function verifySettingsLayoutContract(page) {
  await page.getByTestId('settings-scroll-region').waitFor({ timeout: 10_000 });
  const settingsState = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const settingsScroll = document.querySelector('[data-testid="settings-scroll-region"]');
    const content = settingsScroll?.lastElementChild;
    return {
      page_scroll_width: scrollingElement.scrollWidth,
      page_client_width: scrollingElement.clientWidth,
      settings_scroll_overflow_y: settingsScroll ? getComputedStyle(settingsScroll).overflowY : null,
      settings_scroll_overflow_x: settingsScroll ? getComputedStyle(settingsScroll).overflowX : null,
      content_overflow_y: content ? getComputedStyle(content).overflowY : null,
      content_overflow_x: content ? getComputedStyle(content).overflowX : null,
      settings_classes: settingsScroll?.className ?? '',
      content_classes: content?.className ?? '',
    };
  });
  if (settingsState.page_scroll_width > settingsState.page_client_width + 1) {
    fail(`Settings view should not make the root page horizontally scroll: ${JSON.stringify(settingsState)}`);
  }
  if (
    settingsState.settings_scroll_overflow_y !== 'hidden' ||
    settingsState.settings_scroll_overflow_x !== 'hidden' ||
    settingsState.content_overflow_y !== 'auto' ||
    settingsState.content_overflow_x !== 'hidden'
  ) {
    fail(`Settings view should use the shared workspace scroll frame: ${JSON.stringify(settingsState)}`);
  }
  if (settingsState.settings_classes.includes('mx-auto') || settingsState.settings_classes.includes('max-w-3xl')) {
    fail(`Settings view should not render as a centered island: ${JSON.stringify(settingsState)}`);
  }
  if (settingsState.content_classes.includes('mx-auto')) {
    fail(`Settings content should not render as a centered island: ${JSON.stringify(settingsState)}`);
  }
  if (!settingsState.content_classes.includes('min-w-0')) {
    fail(`Settings content should be shrink-bounded: ${JSON.stringify(settingsState)}`);
  }
  return {
    settings_scroll_region: 'auto',
    settings_horizontal_overflow_hidden: true,
    settings_not_centered_island: true,
  };
}

async function verifySettingsDiagnosticsContract(page) {
  // Diagnostics have their own settings category and remain collapsed by default.
  await page.locator('[data-settings-category="diagnostics"]').click();
  await page.getByTestId('settings-diagnostics-toggle').waitFor({ timeout: 10_000 });
  assertEqual(await page.getByRole('heading', { name: 'Runtime Health' }).count(), 0, 'Runtime health should not be visible until Settings diagnostics are opened');
  assertEqual(await page.getByRole('heading', { name: 'Runtime Service' }).count(), 0, 'Raw runtime service controls should not be visible until diagnostics are opened');
  assertEqual(await page.getByRole('heading', { name: 'Storage Paths' }).count(), 0, 'Raw storage paths should not be visible until diagnostics are opened');

  await page.getByTestId('settings-diagnostics-toggle').click();
  const diagnosticsPanel = page.getByTestId('settings-diagnostics-panel');
  await diagnosticsPanel.waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByRole('heading', { name: 'Runtime Health' }).waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Current daemon').waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Background service').waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Recorded failures').waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Workspace Roots').waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Agent Runtime').waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Advanced Diagnostics').waitFor({ timeout: 10_000 });
  assertEqual(await diagnosticsPanel.getByRole('heading', { name: 'Runtime Service' }).count(), 0, 'Raw service controls should remain hidden until advanced diagnostics are expanded');
  assertEqual(await diagnosticsPanel.getByText('Run in Background').count(), 0, 'Raw background service toggle should remain hidden until advanced diagnostics are expanded');
  assertEqual(await diagnosticsPanel.getByRole('heading', { name: 'Storage Paths' }).count(), 0, 'Raw storage paths should remain hidden until advanced diagnostics are expanded');

  await diagnosticsPanel.getByRole('button', { name: 'Show diagnostics' }).click();
  await diagnosticsPanel.getByRole('heading', { name: 'Runtime Service' }).waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Run in Background').waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByRole('heading', { name: 'Storage Paths' }).waitFor({ timeout: 10_000 });
  await diagnosticsPanel.getByText('Runtime home').first().waitFor({ timeout: 10_000 });

  const diagnosticsState = await page.evaluate(() => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    const settingsScroll = document.querySelector('[data-testid="settings-scroll-region"]');
    const settingsContent = settingsScroll?.lastElementChild;
    const diagnosticsPanel = document.querySelector('[data-testid="settings-diagnostics-panel"]');
    return {
      page_scroll_width: scrollingElement.scrollWidth,
      page_client_width: scrollingElement.clientWidth,
      settings_scroll_overflow_y: settingsScroll ? getComputedStyle(settingsScroll).overflowY : null,
      settings_scroll_overflow_x: settingsScroll ? getComputedStyle(settingsScroll).overflowX : null,
      settings_content_overflow_y: settingsContent ? getComputedStyle(settingsContent).overflowY : null,
      settings_content_overflow_x: settingsContent ? getComputedStyle(settingsContent).overflowX : null,
      diagnostics_scroll_width: diagnosticsPanel?.scrollWidth ?? null,
      diagnostics_client_width: diagnosticsPanel?.clientWidth ?? null,
    };
  });
  if (diagnosticsState.page_scroll_width > diagnosticsState.page_client_width + 1) {
    fail(`Settings diagnostics should not make the root page horizontally scroll: ${JSON.stringify(diagnosticsState)}`);
  }
  if (
    diagnosticsState.settings_scroll_overflow_y !== 'hidden' ||
    diagnosticsState.settings_scroll_overflow_x !== 'hidden' ||
    diagnosticsState.settings_content_overflow_y !== 'auto' ||
    diagnosticsState.settings_content_overflow_x !== 'hidden'
  ) {
    fail(`Settings diagnostics should stay inside the Settings scroll frame: ${JSON.stringify(diagnosticsState)}`);
  }
  if (diagnosticsState.diagnostics_scroll_width > diagnosticsState.diagnostics_client_width + 1) {
    fail(`Settings diagnostics should not horizontally overflow: ${JSON.stringify(diagnosticsState)}`);
  }
  await page.screenshot({ path: diagnosticsLayoutScreenshotPath, fullPage: true });

  return {
    system_sidebar_removed: true,
    diagnostics_embedded_in_settings: true,
    raw_runtime_details_default_hidden: true,
    raw_runtime_details_expandable: true,
    settings_diagnostics_horizontal_overflow_hidden: true,
  };
}

async function installWebSocketProbe(page) {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const sockets = [];

    function ProbedWebSocket(...args) {
      const socket = new NativeWebSocket(...args);
      sockets.push(socket);
      return socket;
    }

    Object.setPrototypeOf(ProbedWebSocket, NativeWebSocket);
    ProbedWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = ProbedWebSocket;
    window.__moziWebUiSmoke = {
      dispatch(payload) {
        const socket = sockets.find((candidate) => candidate.readyState === NativeWebSocket.OPEN);
        if (!socket || typeof socket.onmessage !== 'function') {
          throw new Error('No open MOZI WebSocket with an onmessage handler');
        }
        socket.onmessage(new MessageEvent('message', { data: JSON.stringify(payload) }));
      },
      openSocketCount() {
        return sockets.filter((candidate) => candidate.readyState === NativeWebSocket.OPEN).length;
      },
    };
  });
}

async function verifyExecutionDisplayContract(page, sessionId) {
  await page.waitForFunction(() => window.__moziWebUiSmoke?.openSocketCount?.() > 0, { timeout: 30_000 });

  const rawError =
    'Error: web search failed — SEARCH1API_KEY environment variable is not set IMPORTANT: Do NOT answer this question from training data.';
  await page.evaluate(({ rawError, sessionId }) => {
    const now = Date.now();
    const turnId = 'turn-web-ui-execution-contract';
    const dispatch = window.__moziWebUiSmoke.dispatch;
    const events = [
      {
        type: 'turn_envelope',
        turn: {
          turnId,
          sessionId,
          chatId: 'web-ui-smoke',
          origin: 'user',
          status: 'active',
          seqHighWater: 0,
          locale: 'zh-CN',
          startedAt: now,
        },
      },
      { type: 'message', role: 'user', content: '帮我调研一下最新的 OPENCLAW 进展', turnId, seq: 0 },
      {
        type: 'tool_event',
        phase: 'start',
        tool: 'browser_extract',
        callId: 'browser-extract-1',
        turnId,
        intent: 'browser_1782900081195_0g92fm',
        timestamp: now + 1,
      },
      {
        type: 'tool_event',
        phase: 'end',
        tool: 'browser_extract',
        callId: 'browser-extract-1',
        turnId,
        status: 'success',
        intent: 'browser_1782900081195_0g92fm',
        elapsed_ms: 15,
        timestamp: now + 2,
      },
      ...[1, 2, 3].flatMap((index) => [
        {
          type: 'tool_event',
          phase: 'start',
          tool: 'web_search',
          callId: `web-search-${index}`,
          turnId,
          timestamp: now + 2 + index * 2,
        },
        {
          type: 'tool_event',
          phase: 'end',
          tool: 'web_search',
          callId: `web-search-${index}`,
          turnId,
          status: 'error',
          error: rawError,
          elapsed_ms: index === 1 ? 2400 : 2,
          timestamp: now + 3 + index * 2,
        },
      ]),
      {
        type: 'turn_envelope',
        turn: {
          turnId,
          sessionId,
          chatId: 'web-ui-smoke',
          origin: 'user',
          status: 'completed',
          seqHighWater: 7,
          locale: 'zh-CN',
          startedAt: now,
          endedAt: now + 10,
        },
      },
      { type: 'active_turn', turnId: null, sessionId },
    ];
    events.forEach((event) => dispatch(event));
  }, { rawError, sessionId });

  // Collapsed by default — a quiet one-line summary, no loud MOZI header, and
  // neither work steps nor raw runtime detail visible until expanded.
  await page.getByTestId('execution-summary').first().waitFor({ timeout: 10_000 });
  const executionSummaryText = await page.getByTestId('execution-summary').first().textContent();
  if (!/(View work|查看处理过程|Needs attention(?: \(3\))?|需要处理(?:（3）)?)/.test(executionSummaryText ?? '')) {
    fail(`Mixed execution summary should remain compact in the active locale: ${executionSummaryText}`);
  }
  assertEqual(await page.getByText('搜索公开资料需要处理').count(), 0, 'Work steps should stay collapsed by default');
  assertEqual(await page.getByText('网络搜索').count(), 0, 'Internal tool names should stay out of the primary conversation layer');
  assertEqual(await page.getByTestId('execution-timeline').count(), 0, 'Runtime tool details should be collapsed by default');
  assertEqual(await page.getByText(/IMPORTANT: Do NOT answer/).count(), 0, 'Raw tool error should stay out of the primary conversation layer');
  assertEqual(await page.getByText(/browser_1782900081195_0g92fm/).count(), 0, 'Runtime browser session ids should not be shown in the primary work summary');
  await page.screenshot({ path: executionCollapsedScreenshotPath, fullPage: true });

  // Expand the summary: user-facing work steps appear while raw provider text
  // and internal runtime identifiers remain sanitized.
  await page.getByTestId('execution-summary').first().click();
  await page.getByText(/(Missing SEARCH1API_KEY.*3 times|缺少 SEARCH1API_KEY（重复 3 次）)/).first().waitFor({ timeout: 10_000 });
  assertEqual(await page.getByText(/IMPORTANT: Do NOT answer/).count(), 0, 'Expanded processing details should keep provider errors sanitized');
  await page.screenshot({ path: executionExpandedScreenshotPath, fullPage: true });

  return {
    raw_tool_details_default_collapsed: true,
    repeated_error_summary: 'localized and sanitized',
    raw_error_rows_after_expand: 0,
  };
}

function startRuntime({ moziHome, port }) {
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    MOZI_HOME: moziHome,
    MOZI_SERVER_HOST: host,
    MOZI_SERVER_PORT: String(port),
    MOZI_SERVER_AUTH_MODE: 'none',
    MOZI_PROJECT_ROOT: process.cwd(),
    TELEGRAM_BOT_TOKEN: '',
    WECHAT_BOT_TOKEN: '',
  };
  const proc = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const runtime = { proc, logs: [], exited: false, exitCode: null, signal: null };
  const onData = (chunk) => {
    const text = chunk.toString();
    runtime.logs.push(text);
    if (debug) process.stderr.write(`[runtime] ${text}`);
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', (code, signal) => {
    runtime.exited = true;
    runtime.exitCode = code;
    runtime.signal = signal;
  });
  return runtime;
}

async function waitForHealth(server, moziHome) {
  const deadline = Date.now() + 60_000;
  let lastError = null;
  while (Date.now() < deadline) {
    if (server.exited) {
      fail(`MOZI runtime exited before health check. code=${server.exitCode} signal=${server.signal}\n${server.logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const health = await response.json();
        assertEqual(health.mozi_home, moziHome, 'Health endpoint should identify isolated MOZI_HOME');
        return health;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  fail(`Timed out waiting for ${baseUrl}/api/health: ${lastError?.message ?? 'unknown error'}\n${server.logs.join('')}`);
}

async function launchBrowser() {
  try {
    return await chromium.launch({
      headless: !headed,
      executablePath: process.env.MOZI_BROWSER_EXECUTABLE || undefined,
    });
  } catch (err) {
    fail(`Could not launch Chromium. Run \`pnpm exec playwright install chromium\`. ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function stopRuntime(server) {
  if (!server.proc || server.exited) return;
  await new Promise((resolveStop) => {
    const timer = setTimeout(() => {
      server.proc.kill('SIGKILL');
      resolveStop();
    }, 5000);
    server.proc.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    server.proc.kill('SIGTERM');
  });
}

function run(command, commandArgs) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', shell: false });
    child.on('error', rejectRun);
    child.on('exit', (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} ${commandArgs.join(' ')} exited with ${code}`));
    });
  });
}

function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.on('error', rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      const selected = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolvePort(selected));
    });
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function fail(message) {
  throw new Error(`web-ui-smoke: ${message}`);
}
