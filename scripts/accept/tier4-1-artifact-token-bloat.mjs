#!/usr/bin/env node
/**
 * Tier 4.1 (issue #337): a created artifact's full body must NOT be re-fed into
 * every subsequent LLM request. Pre-fix the artifact was persisted as a
 * {"_artifact":true,...} tool row and passed through context history verbatim,
 * so each later turn re-sent ~the whole artifact as tokens.
 *
 * PASS = the artifact body sentinel is absent from turn-2's LLM request(s).
 * FAIL = the sentinel (full artifact body) is re-sent on turn 2.
 *
 * Uses the deterministic fake model, which captures the exact request bodies the
 * real runtime sends — so this observes the true LLM-facing history.
 */
import { chromium } from 'playwright';
import { startFakeOpenAI } from './fake-openai-server.mjs';
import { startRuntime, completeOnboardingIfNeeded, createSession, sendMessage, chatText, waitTurnIdle } from './_harness.mjs';

const SENTINEL = 'ARTIFACT_BODY_SENTINEL_9f3xQ';

async function main() {
  const fake = await startFakeOpenAI({ mode: 'artifact_sentinel' });
  const rt = await startRuntime({ fakeBaseUrl: fake.baseUrl });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(rt.baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await completeOnboardingIfNeeded(page);
    const title = `T41-${Date.now()}`;
    await createSession(page, title);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('aside').waitFor({ timeout: 20_000 });
    await page.getByText(title, { exact: false }).first().click({ timeout: 15_000 });
    await page.locator('[data-testid="composer-submit"]').waitFor({ timeout: 15_000 });

    // Turn 1: create the artifact (body carries the sentinel). Wait for the
    // whole turn to finish (composer idle) before starting turn 2.
    await sendMessage(page, 'create the report artifact');
    if (!(await waitTurnIdle(page, { timeoutMs: 40000 }))) throw new Error('turn 1 never returned to idle');
    if ((await page.locator('[data-testid="chat-scroll-region"] [data-artifact-kind]').count()) === 0) {
      throw new Error('turn 1 did not produce an artifact card');
    }
    await page.waitForTimeout(500); // let persistence settle

    // Only inspect what turn 2 sends.
    fake.clearRequests();

    // Turn 2: a fresh message → context history is rebuilt from the DB.
    await sendMessage(page, 'thanks, anything else?');
    if (!(await waitTurnIdle(page, { timeoutMs: 40000 }))) throw new Error('turn 2 never returned to idle');
    await page.waitForTimeout(300);

    const reqs = fake.getRequests();
    const withSentinel = reqs.filter((r) => (r.raw || '').includes(SENTINEL));
    if (withSentinel.length === 0) {
      console.log(`PASS tier4-1-artifact-token-bloat: artifact body absent from all ${reqs.length} turn-2 LLM request(s)`);
    } else {
      console.error(`FAIL tier4-1-artifact-token-bloat: artifact body re-sent in ${withSentinel.length}/${reqs.length} turn-2 request(s)`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('ERROR tier4-1:', err?.message || err);
    console.error('--- runtime logs ---\n' + rt.tailLogs(25));
    process.exitCode = 2;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await rt.stop();
    await fake.close();
  }
}
main();
