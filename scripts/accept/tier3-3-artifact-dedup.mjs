#!/usr/bin/env node
/**
 * Tier 3.3 (issue #336): two concurrently-opened artifacts with the SAME title
 * must both survive. Pre-fix the client deduped by (running + title), so the
 * second artifact_open replaced the first and one card vanished.
 *
 * PASS = two artifact cards present after two same-title create_artifact calls.
 * FAIL = fewer than two (title-collision replacement).
 */
import { chromium } from 'playwright';
import { startFakeOpenAI } from './fake-openai-server.mjs';
import { startRuntime, completeOnboardingIfNeeded, createSession, sendMessage, chatText } from './_harness.mjs';

async function main() {
  const fake = await startFakeOpenAI({ mode: 'two_artifacts' });
  const rt = await startRuntime({ fakeBaseUrl: fake.baseUrl });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(rt.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await completeOnboardingIfNeeded(page);
    const title = `T33-${Date.now()}`;
    await createSession(page, title);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('aside').waitFor({ timeout: 20_000 });
    await page.getByText(title, { exact: false }).first().click({ timeout: 15_000 });
    await page.locator('[data-testid="composer-submit"]').waitFor({ timeout: 15_000 });

    await sendMessage(page, 'make two artifacts with the same title');
    let done = false;
    for (let i = 0; i < 60; i++) {
      if ((await chatText(page)).includes('Created two artifacts')) { done = true; break; }
      await page.waitForTimeout(250);
    }
    if (!done) throw new Error('turn never completed (no scripted final answer)');
    await page.waitForTimeout(500);

    const cards = await page.locator('[data-testid="chat-scroll-region"] [data-artifact-kind]').count();
    if (cards === 2) {
      console.log('PASS tier3-3-artifact-dedup: both same-title artifacts kept (2 cards)');
    } else {
      console.error(`FAIL tier3-3-artifact-dedup: expected 2 artifact cards, found ${cards} (title-collision replacement?)`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('ERROR tier3-3:', err?.message || err);
    console.error('--- runtime logs ---\n' + rt.tailLogs(25));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await rt.stop();
    await fake.close();
  }
}
main();
