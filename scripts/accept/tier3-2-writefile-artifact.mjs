#!/usr/bin/env node
/**
 * Tier 3.2 (issue #336): write_file must not open an artifact card for a
 * non-renderable file type. A `.py` write should produce NO artifact card
 * (pre-fix the live tracker opened one for ANY write_file, leaving a stuck /
 * mis-rendered card).
 *
 * PASS = zero artifact cards after a .py write completes.
 * FAIL = an artifact card appears for the .py write.
 */
import { chromium } from 'playwright';
import { startFakeOpenAI } from './fake-openai-server.mjs';
import { startRuntime, completeOnboardingIfNeeded, createSession, sendMessage, chatText } from './_harness.mjs';

async function main() {
  const fake = await startFakeOpenAI({ mode: 'writefile:report.py' });
  const rt = await startRuntime({ fakeBaseUrl: fake.baseUrl });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(rt.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await completeOnboardingIfNeeded(page);
    const title = `T32-${Date.now()}`;
    await createSession(page, title);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('aside').waitFor({ timeout: 20_000 });
    await page.getByText(title, { exact: false }).first().click({ timeout: 15_000 });
    await page.locator('[data-testid="composer-submit"]').waitFor({ timeout: 15_000 });

    await sendMessage(page, 'write a python file');
    // Wait for the turn to complete (scripted final answer).
    let done = false;
    for (let i = 0; i < 60; i++) {
      if ((await chatText(page)).includes('Wrote report.py')) { done = true; break; }
      await page.waitForTimeout(250);
    }
    if (!done) throw new Error('turn never completed (no scripted final answer)');
    // Give any stray artifact_open a beat to render.
    await page.waitForTimeout(500);

    const cards = await page.locator('[data-testid="chat-scroll-region"] [data-artifact-kind]').count();
    if (cards === 0) {
      console.log('PASS tier3-2-writefile-artifact: no artifact card for a .py write');
    } else {
      console.error(`FAIL tier3-2-writefile-artifact: ${cards} artifact card(s) opened for a non-renderable .py write`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('ERROR tier3-2:', err?.message || err);
    console.error('--- runtime logs ---\n' + rt.tailLogs(25));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await rt.stop();
    await fake.close();
  }
}
main();
