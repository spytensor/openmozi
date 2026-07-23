#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const appBinary = resolve('desktop/dist/mac-arm64/MOZI.app/Contents/MacOS/MOZI');

for (let cycle = 1; cycle <= 5; cycle += 1) {
  const home = mkdtempSync(join(tmpdir(), `mozi-navigation-${cycle}-`));
  const workspace = join(home, 'workspace');
  const cdpPort = 19300 + cycle;
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(home, 'mozi.json'), `${JSON.stringify({
    server: { host: '127.0.0.1', port: 9210, auth_mode: 'none' },
    brain: { model: 'gpt-4.1-mini' },
    model_router: { brain_provider: 'openai' },
    providers: { openai: { apikey: 'navigation-race-placeholder' } },
    workspace: { dir: workspace },
  }, null, 2)}\n`);

  const child = spawn(appBinary, [`--remote-debugging-port=${cdpPort}`], {
    env: { ...process.env, PATH: '/usr/bin:/bin', MOZI_HOME: home, MOZI_SERVER_AUTH_MODE: 'none' },
    stdio: 'ignore',
  });
  let browser;
  try {
    browser = await connect(cdpPort);
    const page = await runtimePage(browser);
    if (!page.url().startsWith('http://127.0.0.1:9210/')) throw new Error(`cycle ${cycle}: ${page.url()}`);
  } finally {
    await browser?.close().catch(() => undefined);
    child.kill('SIGTERM');
    await exit(child);
    await waitForPortClosed();
    rmSync(home, { recursive: true, force: true });
  }
  console.log(`PASS navigation cycle ${cycle}`);
}

async function connect(port) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch {}
    await sleep(250);
  }
  throw new Error(`CDP ${port} did not start`);
}

async function runtimePage(browser) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const page = browser.contexts().flatMap((context) => context.pages())
      .find((candidate) => candidate.url().startsWith('http://127.0.0.1:9210/'));
    if (page) return page;
    await sleep(250);
  }
  throw new Error('healthy packaged runtime never replaced the status page');
}

function exit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('app did not quit')), 15_000);
    child.once('exit', () => { clearTimeout(timer); resolveExit(); });
  });
}

async function waitForPortClosed() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await fetch('http://127.0.0.1:9210/api/health'); } catch { return; }
    await sleep(250);
  }
  throw new Error('owned runtime remained on port 9210');
}

function sleep(ms) { return new Promise((resolveSleep) => setTimeout(resolveSleep, ms)); }
