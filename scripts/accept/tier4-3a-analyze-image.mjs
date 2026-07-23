#!/usr/bin/env node
/**
 * Tier 4.3a (issue #337): analyze_image must not read sensitive paths that the
 * TEL deny-list forbids. Pre-fix it bypassed validatePath and would read e.g.
 * /etc/* or ~/.ssh/* and ship the bytes to a third-party vision API.
 *
 * Drives the REAL tool executor (executeWebTool) with a denied path.
 * PASS = denied before reading (is_error with a denial-style message).
 * FAIL = not denied (no error, or a non-denial error implying it read the file).
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const DENY_WORDS = ['not allowed', 'denied', 'permission', 'forbidden', 'outside', 'restricted', 'sensitive', 'not permitted', 'blocked'];

async function main() {
  const mod = await import(pathToFileURL(resolve('src/tools/web-tools.ts')).href);
  const executeWebTool = mod.executeWebTool;
  if (typeof executeWebTool !== 'function') throw new Error('executeWebTool not exported');

  // /etc/passwd exists (so this is NOT a "file not found") and is under the
  // denied /etc root — the fix must reject it at path validation.
  const res = await executeWebTool('analyze_image', { path: '/etc/passwd' }, 'ai-1', {});
  const content = String(res?.content ?? '');
  const lower = content.toLowerCase();
  const denied = res?.is_error === true && DENY_WORDS.some((w) => lower.includes(w));
  const notFound = lower.includes('not found');

  if (denied) {
    console.log('PASS tier4-3a-analyze-image: denied sensitive path before reading');
    console.log('  message:', content.slice(0, 120));
  } else if (notFound) {
    console.error('FAIL tier4-3a-analyze-image: reported "not found" — deny-list not applied (path resolved/read attempted)');
    process.exitCode = 1;
  } else {
    console.error('FAIL tier4-3a-analyze-image: path not denied. is_error=' + res?.is_error + ' content=' + content.slice(0, 160));
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error('ERROR:', e?.stack || e); process.exitCode = 2; });
