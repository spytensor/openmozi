/**
 * Shared acceptance harness: launch the real runtime wired to the deterministic
 * fake OpenAI-compat server, drive it with real Chromium.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

export const HOST = '127.0.0.1';

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, HOST, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

export async function waitForHealth(baseUrl, proc, timeoutMs = 30000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    if (proc.exitCode !== null) throw new Error(`runtime exited early (code ${proc.exitCode})`);
    try { const r = await fetch(`${baseUrl}/api/health`); if (r.ok) return await r.json(); } catch (e) { lastErr = e; }
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error(`timeout waiting for health: ${lastErr?.message ?? 'unknown'}`);
}

/** Launch the runtime with brain routed to `fakeBaseUrl` (deepseek openai-compat override). */
export async function startRuntime({ fakeBaseUrl }) {
  const moziHome = mkdtempSync(join(tmpdir(), 'mozi-accept-'));
  const workspaceDir = join(moziHome, 'workspace');
  mkdirSync(workspaceDir, { recursive: true });
  const port = await getFreePort();
  const baseUrl = `http://${HOST}:${port}`;
  writeFileSync(join(moziHome, 'mozi.json'), JSON.stringify({
    server: { host: HOST, port, auth_mode: 'none' },
    brain: { model: 'deepseek-v4-flash' },
    model_router: { brain_provider: 'deepseek' },
    providers: { deepseek: { apikey: 'accept-fake-key' } },
    telegram: { bot_token: '' }, wechat: { bot_token: '' },
    workspace: { dir: workspaceDir },
    tools: { fs: { workspace_only: true, additional_allowed_roots: [moziHome] }, subagents: { enabled: false } },
  }, null, 2));

  const env = {
    ...process.env, NODE_NO_WARNINGS: '1', MOZI_HOME: moziHome,
    MOZI_SERVER_HOST: HOST, MOZI_SERVER_PORT: String(port), MOZI_SERVER_AUTH_MODE: 'none',
    MOZI_PROJECT_ROOT: process.cwd(),
    DEEPSEEK_BASE_URL: fakeBaseUrl, DEEPSEEK_API_KEY: 'accept-fake-key',
    TELEGRAM_BOT_TOKEN: '', WECHAT_BOT_TOKEN: '',
  };
  const proc = spawn(process.execPath, ['dist/index.js'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs = [];
  proc.stdout.on('data', (c) => logs.push(c.toString()));
  proc.stderr.on('data', (c) => logs.push(c.toString()));
  await waitForHealth(baseUrl, proc);
  return {
    proc, baseUrl, moziHome, logs,
    stop: async () => {
      proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (proc.exitCode === null) proc.kill('SIGKILL');
      rmSync(moziHome, { recursive: true, force: true });
    },
    tailLogs: (n = 25) => logs.join('').split('\n').slice(-n).join('\n'),
  };
}

export async function completeOnboardingIfNeeded(page) {
  const welcome = page.getByRole('heading', { name: /Welcome to (MOZI|your agent runtime)/ });
  const isOnboarding = await welcome.waitFor({ timeout: 12_000 }).then(() => true).catch(() => false);
  if (!isOnboarding) return;
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByPlaceholder('Your name').fill('Local User');
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByPlaceholder(/API key/i).fill('accept-fake-key');
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByRole('button', { name: /Next/ }).click();
  await page.getByRole('button', { name: /Get Started/ }).click();
}

export async function createSession(page, title) {
  const r = await page.evaluate(async (t) => {
    const resp = await fetch('/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ title: t }) });
    return resp.json();
  }, title);
  if (!r?.session?.id) throw new Error(`failed to create session ${title}`);
  return r.session.id;
}

export async function sendMessage(page, text) {
  await page.locator('[data-testid="composer"] textarea').fill(text);
  await page.locator('[data-testid="composer-submit"]').click();
}

export async function chatText(page) {
  return page.locator('[data-testid="chat-scroll-region"]').innerText().catch(() => '');
}

/** Wait until the composer submit button returns to idle (turn finished). */
export async function waitTurnIdle(page, { timeoutMs = 30000 } = {}) {
  const start = Date.now();
  // First let it enter working (best-effort), then wait for idle.
  await page.waitForTimeout(300);
  while (Date.now() - start < timeoutMs) {
    const s = await page.getAttribute('[data-testid="composer-submit"]', 'data-state').catch(() => null);
    if (s === 'idle') return true;
    await page.waitForTimeout(200);
  }
  return false;
}
