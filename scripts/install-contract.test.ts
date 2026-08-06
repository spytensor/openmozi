import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The install contract is only as good as its declarations, and every part of
 * it has already failed silently once: `pnpm-workspace.yaml`'s `allowBuilds`
 * was never honoured (so a clean clone never downloaded the Electron binary),
 * and nothing declared a Node range at all (so Node 26 users fell through to a
 * node-gyp source build). These assertions exist so that regression is loud.
 */

interface Manifest {
  engines?: { node?: string; pnpm?: string };
  packageManager?: string;
  pnpm?: { onlyBuiltDependencies?: string[] };
}

function manifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
}

const MANIFESTS = ['package.json', 'ui/package.json', 'desktop/package.json'];

describe('install contract', () => {
  it('declares the same Node and pnpm range in every workspace manifest', () => {
    const expected = manifest('package.json').engines;
    expect(expected?.node).toBe('>=22.12');
    expect(expected?.pnpm).toBe('10.29.2');

    for (const path of MANIFESTS) {
      const engines = manifest(path).engines;
      expect(engines, path).toEqual(expected);
    }
  });

  it('keeps engines.pnpm and packageManager on the same version', () => {
    const root = manifest('package.json');
    expect(root.packageManager).toBe(`pnpm@${root.engines?.pnpm}`);
  });

  it('ships the version files a fresh clone needs', () => {
    expect(readFileSync('.nvmrc', 'utf8').trim()).toBe('22');
    const npmrc = readFileSync('.npmrc', 'utf8');
    // Without these two the install behaves differently per user: peers resolve
    // (or not) from their global config, and a bad Node version is a warning.
    expect(npmrc).toMatch(/^auto-install-peers=true$/m);
    expect(npmrc).toMatch(/^engine-strict=true$/m);
  });

  it('allows the build scripts native dependencies need, from a single source', () => {
    const allowed = manifest('package.json').pnpm?.onlyBuiltDependencies ?? [];
    // electron is the one that regressed: its postinstall downloads the binary,
    // and without it `desktop:dev`/`desktop:pack:mac` fail after a clean install.
    for (const name of ['better-sqlite3', 'electron', 'esbuild']) {
      expect(allowed, `${name} must be allowed to run its build script`).toContain(name);
    }
    // A second allowlist silently loses to this one — pnpm 10.29.2 read only
    // package.json, which is exactly how electron stopped installing.
    if (existsSync('pnpm-workspace.yaml')) {
      expect(readFileSync('pnpm-workspace.yaml', 'utf8')).not.toMatch(/^allowBuilds:/m);
    }
  });

  it('keeps exactly one lockfile', () => {
    expect(existsSync('pnpm-lock.yaml')).toBe(true);
    // A stale ui/pnpm-lock.yaml once pinned React 19 against React 18 source
    // and shipped to the public repo.
    expect(existsSync('ui/pnpm-lock.yaml')).toBe(false);
  });

  it('rebuilds native runtime dependencies with the staged desktop Node', () => {
    const prepareRuntime = readFileSync('scripts/prepare-desktop-runtime.mjs', 'utf8');
    expect(prepareRuntime).toContain("npmCli, 'rebuild', 'better-sqlite3'");
    expect(prepareRuntime).toContain("const db = new Database(':memory:');");
    expect(prepareRuntime).toContain('PATH: `${dirname(nodeBin)}${delimiter}');
  });
});
