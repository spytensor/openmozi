#!/usr/bin/env node
/**
 * Tier 1 acceptance — git tool command injection (issue #334, item 1.1).
 *
 * Drives the REAL tool-execution code path (`executeGitTool`, the exact
 * function the Brain's tool loop invokes) with a malicious `file` argument
 * that attempts shell command injection via `git diff -- <file>`.
 *
 * PASS  = the injected `touch <sentinel>` never runs (sentinel absent).
 * FAIL  = sentinel created => injection succeeded (vulnerable build).
 *
 * Runs the actual source through tsx — no mocks, no stubs.
 */
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const sentinelDir = mkdtempSync(join(tmpdir(), 'mozi-git-inj-'));
const sentinel = join(sentinelDir, 'PWNED');

async function main() {
  const mod = await import(pathToFileURL(resolve('src/tools/git-tools.ts')).href);
  const executeGitTool = mod.executeGitTool;
  if (typeof executeGitTool !== 'function') {
    throw new Error('executeGitTool not exported — cannot exercise real path');
  }

  const payloads = [
    { name: 'git_diff', arguments: JSON.stringify({ file: `x; touch ${sentinel}` }), id: 'inj-1' },
    { name: 'git_diff', arguments: JSON.stringify({ file: `$(touch ${sentinel})` }), id: 'inj-2' },
    { name: 'git_diff', arguments: JSON.stringify({ file: `\`touch ${sentinel}\`` }), id: 'inj-3' },
  ];

  for (const p of payloads) {
    try {
      // Real executor; args come as a parsed object in the runtime, mirror that.
      await executeGitTool(p.name, JSON.parse(p.arguments), p.id);
    } catch {
      // A thrown error (e.g. git diff failure on a bogus pathspec) is fine —
      // what matters is whether the injected command executed.
    }
    if (existsSync(sentinel)) {
      console.error(`FAIL: injection executed via payload "${p.arguments}" — sentinel created`);
      console.error(`VULNERABLE: git tool passes unescaped input to the shell.`);
      cleanup();
      process.exit(1);
    }
  }

  console.log('PASS tier1-git-injection: 3/3 injection payloads blocked (no sentinel created)');
  console.log(`  exercised: executeGitTool(git_diff) with "; touch", "$( )", and backtick payloads`);
  cleanup();
}

function cleanup() {
  try { rmSync(sentinelDir, { recursive: true, force: true }); } catch {}
}

main().catch((err) => {
  console.error('ERROR running acceptance:', err?.stack || err);
  cleanup();
  process.exit(2);
});
