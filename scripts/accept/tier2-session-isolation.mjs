#!/usr/bin/env node
/**
 * Tier 2 acceptance — WebSocket events must not leak across sessions (issue #335).
 *
 * Real runtime + real Chromium (Playwright), two pages as the same user:
 *   - pageA views session A, pageB views session B.
 *   - pageA sends a message → backend registers a turn for session A and
 *     broadcasts active_turn / task_progress to EVERY connection of the user.
 *   - pageB (session B) must ignore those session-A events.
 *
 * Signal: the composer submit button exposes data-state="idle|working".
 *   PASS = pageA goes "working" (its own turn) while pageB stays "idle".
 *   FAIL = pageB flips to "working" => session-A turn leaked into session B.
 *
 * No LLM needed: active_turn/task_progress are emitted before the model call,
 * and they ride the exact same client-side sessionId filter as stream/tool/
 * artifact events, so this deterministically exercises the Tier 2 fix.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';

const host = '127.0.0.1';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, host, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
async function waitForHealth(baseUrl, proc, timeoutMs = 30000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`runtime exited early (code ${proc.exitCode})`);
    try { const r = await fetch(`${baseUrl}/api/health`); if (r.ok) return await r.json(); } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error(`timeout waiting for health: ${lastErr?.message ?? 'unknown'}`);
}
async function completeOnboardingIfNeeded(page) {
  const welcome = page.getByRole('heading', { name: /Welcome to (MOZI|your agent runtime)/ });
  const isOnboarding = await welcome.waitFor({ timeout: 12_000 }).then(() => true).catch(() => false);
  if (!isOnboarding) return;
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByPlaceholder('Your name').fill('Local User');
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByPlaceholder(/API key/i).fill('tier2-smoke-key');
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByRole('button', { name: /Get Started/ }).click();
}
async function submitState(page) {
  return page.getAttribute('[data-testid="composer-submit"]', 'data-state').catch(() => null);
}

async function main() {
  const moziHome = mkdtempSync(join(tmpdir(), 'mozi-tier2-'));
  const workspaceDir = join(moziHome, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://${host}:${port}`;
  writeFileSync(join(moziHome, 'mozi.json'), JSON.stringify({
    server: { host, port, auth_mode: 'none' },
    brain: { model: 'gpt-4.1-mini' },
    model_router: { brain_provider: 'openai' },
    providers: { openai: { apikey: 'tier2-smoke-key' } },
    telegram: { bot_token: '' }, wechat: { bot_token: '' },
    workspace: { dir: workspaceDir },
    tools: { fs: { workspace_only: true, additional_allowed_roots: [moziHome] }, subagents: { enabled: false } },
  }, null, 2));

  const env = { ...process.env, NODE_NO_WARNINGS: '1', MOZI_HOME: moziHome, MOZI_SERVER_HOST: host,
    MOZI_SERVER_PORT: String(port), MOZI_SERVER_AUTH_MODE: 'none', MOZI_PROJECT_ROOT: process.cwd(),
    TELEGRAM_BOT_TOKEN: '', WECHAT_BOT_TOKEN: '' };
  const proc = spawn(process.execPath, ['dist/index.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', (c) => logs.push(c.toString()));
  proc.stderr.on('data', (c) => logs.push(c.toString()));

  let browser;
  const problems = [];
  try {
    await waitForHealth(baseUrl, proc);
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

    // Bootstrap onboarding + create two sessions via one page.
    const boot = await ctx.newPage();
    await boot.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await completeOnboardingIfNeeded(boot);
    const mk = async (title) => {
      const r = await boot.evaluate(async (t) => {
        const resp = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'include', body: JSON.stringify({ title: t }) });
        return resp.json();
      }, title);
      if (!r?.session?.id) throw new Error(`failed to create session ${title}`);
      return { id: r.session.id, title };
    };
    const titleA = `ISO-A-${port}`;
    const titleB = `ISO-B-${port}`;
    const A = await mk(titleA);
    const B = await mk(titleB);
    await boot.close();

    // Two pages, same user, different sessions.
    const pageA = await ctx.newPage();
    const pageB = await ctx.newPage();
    for (const [page, t] of [[pageA, titleA], [pageB, titleB]]) {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.locator('aside').waitFor({ timeout: 20_000 });
      await page.getByText(t, { exact: false }).first().click({ timeout: 15_000 });
      await page.locator('[data-testid="composer-submit"]').waitFor({ timeout: 15_000 });
    }

    // Baseline: both idle.
    const a0 = await submitState(pageA);
    const b0 = await submitState(pageB);
    if (b0 !== 'idle') problems.push(`pageB not idle at baseline (data-state=${b0})`);

    // pageA sends a message → starts a turn for session A.
    await pageA.locator('[data-testid="composer"] textarea').fill('hello from session A');
    await pageA.locator('[data-testid="composer-submit"]').click();

    // Sanity: pageA enters working (turn started, events emitted).
    let aWorking = false;
    for (let i = 0; i < 20; i++) {
      if ((await submitState(pageA)) === 'working') { aWorking = true; break; }
      await pageA.waitForTimeout(150);
    }
    if (!aWorking) problems.push('pageA never entered "working" after send — cannot prove events were emitted');

    // The leak check: pageB must stay idle for the whole observation window.
    let bLeaked = false;
    for (let i = 0; i < 24; i++) { // ~3.6s
      const s = await submitState(pageB);
      if (s === 'working' || s === 'cancelling') { bLeaked = true; break; }
      await pageB.waitForTimeout(150);
    }
    // Also assert no assistant/stream bubble showed up in pageB.
    const bAssistantBubbles = await pageB.locator('[data-testid="chat-scroll-region"]').innerText().catch(() => '');
    const bHasLeakText = bAssistantBubbles.includes('hello from session A');

    if (bLeaked) problems.push('LEAK: pageB (session B) entered working from session A\'s turn (active_turn/task_progress not filtered)');
    if (bHasLeakText) problems.push('LEAK: session A user/assistant content rendered in session B timeline');

    if (problems.length === 0) {
      console.log('PASS tier2-session-isolation: session-A turn did NOT leak into session B');
      console.log('  pageA data-state=working (own turn); pageB stayed idle; no cross-session content');
    } else {
      console.error('FAIL tier2-session-isolation:');
      for (const p of problems) console.error('  - ' + p);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('ERROR tier2-session-isolation:', err?.message || err);
    console.error('--- runtime logs (tail) ---\n' + logs.join('').split('\n').slice(-20).join('\n'));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    proc.kill('SIGTERM');
    await new Promise((res) => setTimeout(res, 500));
    if (proc.exitCode === null) proc.kill('SIGKILL');
    rmSync(moziHome, { recursive: true, force: true });
  }
}

main();
