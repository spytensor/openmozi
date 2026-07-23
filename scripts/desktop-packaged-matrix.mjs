#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { assertExpectedRuntimeOwner, readRuntimeLogOrPlaceholder } from './desktop-packaged-matrix-utils.mjs';

const appBinary = resolve('desktop/dist/mac-arm64/MOZI.app/Contents/MacOS/MOZI');
const outputDir = resolve('output/desktop-matrix');
const reportsDir = resolve('reports');
const home = mkdtempSync(join(tmpdir(), 'mozi-desktop-matrix-'));
const workspace = join(home, 'workspace');
const cdpPort = 19214;
const baseUrl = 'http://127.0.0.1:9210';
const startedAt = new Date().toISOString();
const checks = [];
let appProcess;
let browser;

mkdirSync(workspace, { recursive: true });
mkdirSync(outputDir, { recursive: true });
mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(workspace, 'download-proof.txt'), 'MOZI packaged download proof\n');
writeFileSync(join(home, 'mozi.json'), `${JSON.stringify({
  server: { host: '127.0.0.1', port: 9210, auth_mode: 'none' },
  brain: { model: 'gpt-4.1-mini' },
  model_router: { brain_provider: 'openai' },
  providers: { openai: { apikey: 'desktop-matrix-placeholder' } },
  workspace: { dir: workspace },
  tools: { fs: { workspace_only: true, additional_allowed_roots: [home] } },
}, null, 2)}\n`, { mode: 0o600 });

const record = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  if (!ok) throw new Error(`${name}: ${detail}`);
};

try {
  appProcess = spawn(appBinary, [`--remote-debugging-port=${cdpPort}`], {
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
      MOZI_HOME: home,
      MOZI_SERVER_AUTH_MODE: 'none',
      MOZI_DESKTOP_STARTUP_TIMEOUT_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stderr = [];
  appProcess.stderr.on('data', (chunk) => stderr.push(chunk.toString()));
  await waitForHealth();
  record('launch and health', true, home);

  browser = await connectCdp();
  const page = await waitForRuntimePage(browser);
  record('Electron renderer available', Boolean(page), page.url());
  const desktopBridge = await page.evaluate(() => ({
    present: Boolean(window.moziDesktop),
    selectDirectory: typeof window.moziDesktop?.selectDirectory,
    getBuildInfo: typeof window.moziDesktop?.getBuildInfo,
  }));
  record(
    'native directory picker bridge',
    desktopBridge.present && desktopBridge.selectDirectory === 'function',
    JSON.stringify(desktopBridge),
  );
  record('Desktop build identity bridge', desktopBridge.getBuildInfo === 'function', JSON.stringify(desktopBridge));
  const identities = await page.evaluate(async () => ({
    runtime: await fetch('/api/version').then((response) => response.json()),
    shell: await window.moziDesktop?.getBuildInfo?.(),
  }));
  record(
    'Desktop shell/runtime version parity',
    identities.runtime?.version && identities.runtime.version === identities.shell?.version && identities.runtime.surface === 'desktop',
    JSON.stringify(identities),
  );
  await page.screenshot({ path: join(outputDir, 'packaged-workspace.png'), fullPage: true });
  record('workspace UI rendered', (await page.locator('body').innerText()).trim().length > 20, page.url());

  const apiResults = await page.evaluate(async () => {
    const paths = [
      '/api/auth/status', '/api/onboarding/status', '/api/version', '/api/runtime/workspace',
      '/api/runtime/desktop-capabilities', '/api/sessions', '/api/memory/facts',
      '/api/memory/digests', '/api/fs/roots', '/api/providers', '/api/services',
      '/api/scheduler/tasks', '/api/scheduler/reminders', '/api/dashboard/tasks',
      '/api/skills', '/api/commands', '/api/runtime/logs',
    ];
    return Promise.all(paths.map(async (path) => {
      const response = await fetch(path, { credentials: 'include' });
      return { path, status: response.status };
    }));
  });
  for (const result of apiResults) record(`GET ${result.path}`, result.status === 200, `HTTP ${result.status}`);
  const officeContract = await page.evaluate(async () => {
    const response = await fetch('/api/office/session', { credentials: 'include' });
    return { status: response.status, body: await response.json().catch(() => null) };
  });
  record(
    'GET /api/office/session validates required file path',
    officeContract.status === 400,
    JSON.stringify(officeContract),
  );

  const wsResult = await page.evaluate(() => new Promise((resolveWs) => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    const timer = setTimeout(() => resolveWs({ ok: false, detail: 'timeout' }), 10_000);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      socket.close();
      resolveWs({ ok: true, detail: 'opened' });
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolveWs({ ok: false, detail: 'error' });
    });
  }));
  record('WebSocket connection', wsResult.ok, wsResult.detail);

  const writeResults = await page.evaluate(async () => {
    const call = async (path, init) => {
      const response = await fetch(path, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
      return { status: response.status, body: await response.json().catch(() => null) };
    };
    const session = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ title: 'Desktop matrix session' }) });
    const memory = await call('/api/memory/facts', { method: 'POST', body: JSON.stringify({ value: 'desktop matrix disposable memory', category: 'fact' }) });
    const reminder = await call('/api/scheduler/reminders', { method: 'POST', body: JSON.stringify({ message: 'desktop matrix disposable reminder', delayMinutes: 1440 }) });
    return { session, memory, reminder };
  });
  record('session write', writeResults.session.status < 300, `HTTP ${writeResults.session.status}`);
  record('memory write', writeResults.memory.status < 300, `HTTP ${writeResults.memory.status}`);
  record('scheduler write', writeResults.reminder.status < 300, `HTTP ${writeResults.reminder.status}`);

  const fileResult = await page.evaluate(async (workspacePath) => {
    const response = await fetch(`/api/fs/file?path=${encodeURIComponent(workspacePath + '/download-proof.txt')}`);
    return { status: response.status, text: await response.text() };
  }, workspace);
  record('file download', fileResult.status === 200 && fileResult.text.includes('download proof'), `HTTP ${fileResult.status}`);

  await browser.close();
  browser = undefined;
  appProcess.kill('SIGTERM');
  const exit = await waitForExit(appProcess, 15_000);
  record('graceful quit', exit.signal === 'SIGTERM' || exit.code === 0, JSON.stringify(exit));

  const report = { startedAt, finishedAt: new Date().toISOString(), appBinary, home, checks };
  writeFileSync(join(reportsDir, 'desktop-packaged-matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS desktop packaged matrix (${checks.length} checks)`);
} catch (error) {
  const report = { startedAt, finishedAt: new Date().toISOString(), appBinary, home, checks, error: error instanceof Error ? error.stack : String(error) };
  writeFileSync(join(reportsDir, 'desktop-packaged-matrix.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (appProcess && appProcess.exitCode === null) appProcess.kill('SIGKILL');
  if (!process.env.MOZI_KEEP_MATRIX_HOME) rmSync(home, { recursive: true, force: true });
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        const health = await response.json();
        assertExpectedRuntimeOwner(health, home);
        return;
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('port already owned by ')) throw error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Timed out waiting for packaged health; log=${readRuntimeLogOrPlaceholder(join(home, 'logs/runtime.log'))}`);
}

async function connectCdp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`); } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Timed out connecting to Electron CDP');
}

async function waitForRuntimePage(cdpBrowser) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pages = cdpBrowser.contexts().flatMap((context) => context.pages());
    const runtimePage = pages.find((candidate) => candidate.url().startsWith(baseUrl));
    if (runtimePage) return runtimePage;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const urls = cdpBrowser.contexts().flatMap((context) => context.pages()).map((page) => page.url());
  throw new Error(`Timed out waiting for Electron runtime page; pages=${JSON.stringify(urls)}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('App did not exit gracefully')), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}
