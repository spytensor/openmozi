#!/usr/bin/env node
/**
 * Tier 3.1 (issue #336): cancelling a turn must terminalize in-flight artifacts.
 * A live artifact opened while tool arguments stream must NOT stay stuck in the
 * "running" state after the user clicks stop.
 *
 * PASS = after cancel, no artifact card remains in the running state.
 * FAIL = an artifact card is still "running" (spinner) seconds after cancel.
 */
import { chromium } from 'playwright';
import { startFakeOpenAI } from './fake-openai-server.mjs';
import { startRuntime, completeOnboardingIfNeeded, createSession, sendMessage } from './_harness.mjs';

const RUNNING_LABELS = ['Generating', '生成中', '正在生成'];

async function runningCardCount(page) {
  const cards = page.locator('[data-testid="chat-scroll-region"] [data-artifact-kind]');
  const n = await cards.count();
  let running = 0;
  for (let i = 0; i < n; i++) {
    const txt = await cards.nth(i).innerText().catch(() => '');
    if (RUNNING_LABELS.some((l) => txt.includes(l))) running++;
  }
  return running;
}

async function main() {
  const fake = await startFakeOpenAI({ mode: 'writefile_slow:page.html' });
  const rt = await startRuntime({ fakeBaseUrl: fake.baseUrl });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(rt.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await completeOnboardingIfNeeded(page);
    const title = `T31-${Date.now()}`;
    await createSession(page, title);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('aside').waitFor({ timeout: 20_000 });
    await page.getByText(title, { exact: false }).first().click({ timeout: 15_000 });
    await page.locator('[data-testid="composer-submit"]').waitFor({ timeout: 15_000 });

    await sendMessage(page, 'generate a big html page');

    // Wait for a live artifact to appear in the running state.
    let sawRunning = false;
    for (let i = 0; i < 40; i++) {
      if ((await runningCardCount(page)) > 0) { sawRunning = true; break; }
      await page.waitForTimeout(150);
    }
    if (!sawRunning) throw new Error('no running artifact card appeared to cancel');

    // Cancel: click the submit button while it is in the "working"/stop state.
    const submit = page.locator('[data-testid="composer-submit"]');
    if ((await submit.getAttribute('data-state')) !== 'working') {
      // ensure we are in a cancellable state
      await page.waitForTimeout(200);
    }
    await submit.click();

    // After cancel, the artifact must leave the running state within a few seconds.
    let stillRunning = 1;
    for (let i = 0; i < 30; i++) { // ~4.5s
      stillRunning = await runningCardCount(page);
      if (stillRunning === 0) break;
      await page.waitForTimeout(150);
    }
    if (stillRunning === 0) {
      console.log('PASS tier3-1-cancel-terminal: artifact left running state after cancel (no stuck spinner)');
    } else {
      console.error(`FAIL tier3-1-cancel-terminal: ${stillRunning} artifact card(s) still "running" ~4.5s after cancel`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('ERROR tier3-1:', err?.message || err);
    console.error('--- runtime logs ---\n' + rt.tailLogs(25));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await rt.stop();
    await fake.close();
  }
}
main();
