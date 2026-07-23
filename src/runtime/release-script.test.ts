import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

let root = '';

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

function fixture(versions = { root: '2.0.0', ui: '2.0.0', desktop: '2.0.0' }): string {
  root = mkdtempSync(join(tmpdir(), 'mozi-release-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'ui'));
  mkdirSync(join(root, 'desktop'));
  copyFileSync(join(process.cwd(), 'scripts', 'release.mjs'), join(root, 'scripts', 'release.mjs'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'mozi', version: versions.root }, null, 2));
  writeFileSync(join(root, 'ui', 'package.json'), JSON.stringify({ name: 'mozi-ui', version: versions.ui }, null, 2));
  writeFileSync(join(root, 'desktop', 'package.json'), JSON.stringify({ name: 'mozi-desktop', version: versions.desktop }, null, 2));
  writeFileSync(join(root, 'README.md'), 'Version: v2.0.0\n');
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- Version identity.\n');
  return root;
}

describe('release version governance', () => {
  it('updates runtime, UI and Desktop versions atomically', () => {
    const cwd = fixture();
    execFileSync(process.execPath, ['scripts/release.mjs', '--version', '2.0.1'], { cwd });
    for (const path of ['package.json', 'ui/package.json', 'desktop/package.json']) {
      expect(JSON.parse(readFileSync(join(cwd, path), 'utf8')).version).toBe('2.0.1');
    }
  });

  it('rejects an already divergent product version and a version regression', () => {
    const divergent = fixture({ root: '2.0.0', ui: '2.0.0', desktop: '1.9.9' });
    expect(spawnSync(process.execPath, ['scripts/release.mjs', '--version', '2.0.1'], { cwd: divergent }).status).not.toBe(0);

    rmSync(divergent, { recursive: true, force: true });
    root = '';
    const regressing = fixture();
    expect(spawnSync(process.execPath, ['scripts/release.mjs', '--version', '1.9.9'], { cwd: regressing }).status).not.toBe(0);
  });

  it('refuses to create an empty GitHub Release without an immutable release commit', () => {
    const cwd = fixture();
    const result = spawnSync(
      process.execPath,
      ['scripts/release.mjs', '--version', '2.0.1', '--release', '--unsigned'],
      { cwd, encoding: 'utf8' },
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('--mac-assets requires --commit');
  });
});
