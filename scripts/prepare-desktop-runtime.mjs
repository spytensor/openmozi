#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DEST = join(ROOT, 'desktop', 'resources', 'mozi');

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function assertExists(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} missing at ${path}`);
  }
}

function replaceDir(source, dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(source, dest, { recursive: true });
}

function pruneTopLevel(dest, keepNames) {
  const keep = new Set(keepNames);
  for (const entry of readdirSync(dest)) {
    if (!keep.has(entry)) {
      rmSync(join(dest, entry), { recursive: true, force: true });
    }
  }
}

function runPnpm(args) {
  const pnpmExecPath = process.env.npm_execpath;
  const options = {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, CI: process.env.CI || 'true' },
  };

  if (pnpmExecPath) {
    execFileSync(process.execPath, [pnpmExecPath, ...args], options);
    return;
  }

  execFileSync('pnpm', args, options);
}

async function main() {
  const dest = resolve(getArg('--dest', process.env.MOZI_DESKTOP_RUNTIME_DEST || DEFAULT_DEST));

  assertExists(join(ROOT, 'dist', 'index.js'), 'Built MOZI runtime');
  assertExists(join(ROOT, 'dist', 'store', 'schema.sql'), 'Built database schema');
  assertExists(join(ROOT, 'ui', 'dist', 'index.html'), 'Built Web UI');
  assertExists(join(ROOT, 'bootstrap', 'agents'), 'Bootstrap agents');
  assertExists(join(ROOT, 'skills'), 'Bundled skills');
  assertExists(join(ROOT, 'src', 'templates', 'SOUL.md'), 'Runtime templates');

  console.log(`Preparing MOZI Desktop runtime at ${dest}`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });

  runPnpm(['--filter', '.', 'deploy', '--legacy', '--prod', dest]);

  replaceDir(join(ROOT, 'dist'), join(dest, 'dist'));
  rmSync(join(dest, 'ui'), { recursive: true, force: true });
  replaceDir(join(ROOT, 'ui', 'dist'), join(dest, 'ui', 'dist'));
  replaceDir(join(ROOT, 'bootstrap'), join(dest, 'bootstrap'));
  replaceDir(join(ROOT, 'skills'), join(dest, 'skills'));
  rmSync(join(dest, 'src'), { recursive: true, force: true });
  replaceDir(join(ROOT, 'src', 'templates'), join(dest, 'src', 'templates'));
  cpSync(join(ROOT, 'package.json'), join(dest, 'package.json'));
  pruneTopLevel(dest, ['bootstrap', 'dist', 'node_modules', 'package.json', 'skills', 'src', 'ui']);

  assertExists(join(dest, 'node_modules'), 'Production node_modules');
  assertExists(join(dest, 'dist', 'index.js'), 'Prepared MOZI runtime');
  assertExists(join(dest, 'dist', 'store', 'schema.sql'), 'Prepared database schema');
  assertExists(join(dest, 'ui', 'dist', 'index.html'), 'Prepared Web UI');
  assertExists(join(dest, 'bootstrap', 'agents'), 'Prepared bootstrap agents');
  assertExists(join(dest, 'skills'), 'Prepared bundled skills');
  assertExists(join(dest, 'src', 'templates', 'SOUL.md'), 'Prepared templates');
  console.log('Prepared MOZI Desktop runtime resources.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
