#!/usr/bin/env node
/**
 * Harness plumbing check: one real chat turn end-to-end through the fake model.
 * Not a Tier fix test — validates that the runtime routes to the fake server and
 * a scripted answer streams into the real UI.
 */
import { chromium } from 'playwright';
import { startFakeOpenAI } from './fake-openai-server.mjs';
import { startRuntime, completeOnboardingIfNeeded, createSession, sendMessage, chatText } from './_harness.mjs';

async function main() {
  const fake = await startFakeOpenAI({ mode: 'text' });
  const rt = await startRuntime({ fakeBaseUrl: fake.baseUrl });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(rt.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await completeOnboardingIfNeeded(page);
    const title = `PLUMB-${Date.now()}`;
    await createSession(page, title);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('aside').waitFor({ timeout: 20_000 });
    await page.getByText(title, { exact: false }).first().click({ timeout: 15_000 });
    await page.locator('[data-testid="composer-submit"]').waitFor({ timeout: 15_000 });

    await sendMessage(page, 'hi');
    // Wait for the scripted answer to stream in.
    let seen = false;
    for (let i = 0; i < 40; i++) {
      if ((await chatText(page)).includes('Hello from the scripted model')) { seen = true; break; }
      await page.waitForTimeout(250);
    }
    if (seen) {
      console.log('PASS _plumbing: real turn routed to fake model; scripted answer rendered in UI');
    } else {
      console.error('FAIL _plumbing: scripted answer never appeared');
      console.error('chat text:', (await chatText(page)).slice(0, 400));
      console.error('--- runtime logs ---\n' + rt.tailLogs(30));
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('ERROR _plumbing:', err?.message || err);
    console.error('--- runtime logs ---\n' + rt.tailLogs(30));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await rt.stop();
    await fake.close();
  }
}
main();
