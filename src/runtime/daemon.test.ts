import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDaemonCwd, resolveMainEntryPath, startMoziInBackground } from './daemon.js';

let tmpCwd = '';

beforeEach(() => {
  tmpCwd = mkdtempSync(join(tmpdir(), 'mozi-daemon-test-'));
});

afterEach(() => {
  rmSync(tmpCwd, { recursive: true, force: true });
});

describe('runtime/daemon', () => {
  it('resolveMainEntryPath returns dist/index.js when present in cwd', () => {
    const distDir = join(tmpCwd, 'dist');
    mkdirSync(distDir, { recursive: true });
    const entry = join(distDir, 'index.js');
    writeFileSync(entry, 'console.log("ok")\n', 'utf-8');

    expect(resolveMainEntryPath(tmpCwd)).toBe(entry);
  });

  it('startMoziInBackground fails fast when entrypoint is missing', () => {
    const previousProjectRoot = process.env.MOZI_PROJECT_ROOT;
    process.env.MOZI_PROJECT_ROOT = tmpCwd;
    try {
      const result = startMoziInBackground(tmpCwd);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('dist/index.js');
      }
    } finally {
      if (previousProjectRoot === undefined) {
        delete process.env.MOZI_PROJECT_ROOT;
      } else {
        process.env.MOZI_PROJECT_ROOT = previousProjectRoot;
      }
    }
  });

  it('resolveDaemonCwd prefers project root when entry is under dist/', () => {
    const entry = join(tmpCwd, 'dist', 'index.js');
    expect(resolveDaemonCwd(entry, '/fallback')).toBe(tmpCwd);
  });

  it('resolveDaemonCwd falls back when entry is not under dist/', () => {
    const entry = join(tmpCwd, 'bin', 'index.js');
    expect(resolveDaemonCwd(entry, '/fallback')).toBe('/fallback');
  });
});
