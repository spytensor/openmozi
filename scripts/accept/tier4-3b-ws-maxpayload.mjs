#!/usr/bin/env node
/**
 * Tier 4.3b (issue #337): the WebSocket endpoint must cap frame size so a
 * single huge frame can't buffer unbounded and OOM the process.
 *
 * Connects a raw WebSocket to the REAL runtime and sends an oversized frame.
 * PASS = the server rejects it (connection closes, typically code 1009).
 * FAIL = the frame is accepted (connection stays open) — no maxPayload.
 *
 * Uses Node 22's global WebSocket. No browser needed.
 */
import { startRuntime } from './_harness.mjs';

async function main() {
  // Fake base URL not used for LLM here; runtime just needs to boot.
  const rt = await startRuntime({ fakeBaseUrl: 'http://127.0.0.1:1' });
  try {
    const wsUrl = rt.baseUrl.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);

    const outcome = await new Promise((resolve) => {
      let opened = false;
      const timer = setTimeout(() => resolve(opened ? 'stayed-open' : 'never-opened'), 8000);
      ws.addEventListener('open', () => {
        opened = true;
        // ~8 MB frame — well above a sane 1–2 MB cap.
        const huge = 'x'.repeat(8 * 1024 * 1024);
        try { ws.send(JSON.stringify({ type: 'message', content: huge })); } catch { /* ignore */ }
      });
      ws.addEventListener('close', (ev) => { clearTimeout(timer); resolve('closed:' + ev.code); });
      ws.addEventListener('error', () => { clearTimeout(timer); resolve('errored'); });
    });

    if (outcome.startsWith('closed') || outcome === 'errored') {
      console.log(`PASS tier4-3b-ws-maxpayload: oversized frame rejected (${outcome})`);
    } else {
      console.error(`FAIL tier4-3b-ws-maxpayload: oversized 8MB frame not rejected (${outcome}) — no maxPayload cap`);
      process.exitCode = 1;
    }
    try { ws.close(); } catch { /* ignore */ }
  } catch (err) {
    console.error('ERROR tier4-3b:', err?.message || err);
    console.error(rt.tailLogs(20));
    process.exitCode = 2;
  } finally {
    await rt.stop();
  }
}
main();
