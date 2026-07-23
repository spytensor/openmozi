#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--trace' && next) {
      args.trace = next;
      i += 1;
      continue;
    }
    if (arg === '--tenant' && next) {
      args.tenant = next;
      i += 1;
      continue;
    }
    if (arg === '--out' && next) {
      args.out = next;
      i += 1;
      continue;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.trace) {
  console.error('Usage: node scripts/failure-replay-generate.mjs --trace <trace_id> [--tenant <tenant_id>] [--out <output_dir>]');
  process.exit(1);
}

const modulePath = resolve(process.cwd(), 'dist/observer/failure-replay.js');
if (!existsSync(modulePath)) {
  console.error('Missing dist/observer/failure-replay.js. Run `pnpm build` first.');
  process.exit(1);
}

const replayModule = await import(pathToFileURL(modulePath).href);

if (typeof replayModule.generateFailureReplayArtifacts !== 'function') {
  console.error('generateFailureReplayArtifacts export not found. Rebuild and retry.');
  process.exit(1);
}

const artifacts = replayModule.generateFailureReplayArtifacts(args.trace, {
  tenantId: args.tenant || 'default',
  outputDir: args.out || 'tests/integration/replay',
});

if (!artifacts) {
  console.error(`Trace not found: ${args.trace}`);
  process.exit(1);
}

console.log('Failure replay artifacts generated successfully.');
console.log(`- fixture: ${artifacts.fixturePath}`);
console.log(`- test:    ${artifacts.testPath}`);
