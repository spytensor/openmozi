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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(options: {
  version?: string;
  uiVersion?: string;
  desktopVersion?: string;
  buildVersion?: string;
  buildCommit?: string;
  channel?: 'stable' | 'beta';
} = {}): string {
  const version = options.version ?? '2.0.0';
  const commit = options.buildCommit ?? 'abc123';
  const channel = options.channel ?? 'stable';
  root = mkdtempSync(join(tmpdir(), 'mozi-release-chain-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'ui'), { recursive: true });
  mkdirSync(join(root, 'desktop/dist/mac-arm64/MOZI.app/Contents/Resources/mozi/dist'), { recursive: true });

  copyFileSync(join(process.cwd(), 'scripts/release-supply-chain.mjs'), join(root, 'scripts/release-supply-chain.mjs'));
  writeJson(join(root, 'package.json'), { name: 'mozi', version });
  writeJson(join(root, 'ui/package.json'), { name: 'mozi-ui', version: options.uiVersion ?? version });
  writeJson(join(root, 'desktop/package.json'), { name: 'mozi-desktop', version: options.desktopVersion ?? version });
  writeJson(
    join(root, 'desktop/dist/mac-arm64/MOZI.app/Contents/Resources/mozi/dist/build-info.json'),
    {
      version: options.buildVersion ?? version,
      commit,
      buildTime: '2026-07-11T00:00:00Z',
      channel,
      surface: 'desktop',
    },
  );
  writeFileSync(join(root, 'desktop/dist/MOZI-2.0.0-arm64.dmg'), 'fake dmg bytes');
  writeFileSync(join(root, 'desktop/dist/MOZI-2.0.0-arm64.zip'), 'fake zip bytes');
  return root;
}

function readManifest(cwd: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, 'release/manifest.json'), 'utf8')) as Record<string, unknown>;
}

describe('release supply-chain verifier', () => {
  it('generates a non-publishable manifest with artifact checksums and explicit blockers', () => {
    const cwd = fixture();

    execFileSync(process.execPath, [
      'scripts/release-supply-chain.mjs',
      '--version', '2.0.0',
      '--commit', 'abc123',
      '--channel', 'stable',
      '--out', 'release/manifest.json',
    ], { cwd });

    const manifest = readManifest(cwd);
    expect(manifest.version).toBe('2.0.0');
    expect(manifest.channel).toBe('stable');
    expect(manifest.publishable).toBe(false);
    expect(manifest.release_blockers).toEqual(expect.arrayContaining([
      'macos_app_not_signed',
      'macos_dmg_not_notarized',
      'missing_docker_digest',
    ]));
    expect((manifest.macos as { signed: boolean; signing_identities: string[] }).signed).toBe(false);
    expect((manifest.macos as { signed: boolean; signing_identities: string[] }).signing_identities).toEqual([]);
    expect((manifest.macos as { publishable: boolean }).publishable).toBe(false);
    expect((manifest.macos as { release_blockers: string[] }).release_blockers).toEqual(expect.arrayContaining([
      'macos_app_not_signed',
      'macos_dmg_not_notarized',
    ]));

    const artifacts = manifest.artifacts as Array<{ kind: string; sha256: string; sha512: string }>;
    expect(artifacts.map(artifact => artifact.kind).sort()).toEqual(['macos_dmg', 'macos_zip']);
    expect(artifacts.every(artifact => /^[a-f0-9]{64}$/.test(artifact.sha256))).toBe(true);
    expect(artifacts.every(artifact => artifact.sha512.length > 0)).toBe(true);
  });

  it('fails closed when publishable mode lacks release tag, signing and digest evidence', () => {
    const cwd = fixture();

    const result = spawnSync(process.execPath, [
      'scripts/release-supply-chain.mjs',
      '--version', '2.0.0',
      '--commit', 'abc123',
      '--publishable',
      '--out', 'release/manifest.json',
    ], { cwd, encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toContain('Required release tag is missing');
  });

  it('rejects package and build identity drift before producing release evidence', () => {
    const divergentPackage = fixture({ uiVersion: '2.0.1' });
    expect(spawnSync(process.execPath, [
      'scripts/release-supply-chain.mjs',
      '--version', '2.0.0',
      '--commit', 'abc123',
    ], { cwd: divergentPackage }).status).not.toBe(0);

    rmSync(divergentPackage, { recursive: true, force: true });
    root = '';

    const divergentBuild = fixture({ buildVersion: '2.0.1' });
    expect(spawnSync(process.execPath, [
      'scripts/release-supply-chain.mjs',
      '--version', '2.0.0',
      '--commit', 'abc123',
    ], { cwd: divergentBuild }).status).not.toBe(0);
  });

  it('keeps stable and beta channel promotion explicit', () => {
    const stablePrerelease = fixture({ version: '2.1.0-beta.1', buildVersion: '2.1.0-beta.1' });
    expect(spawnSync(process.execPath, [
      'scripts/release-supply-chain.mjs',
      '--version', '2.1.0-beta.1',
      '--channel', 'stable',
    ], { cwd: stablePrerelease }).status).not.toBe(0);

    rmSync(stablePrerelease, { recursive: true, force: true });
    root = '';

    const beta = fixture({ version: '2.1.0-beta.1', buildVersion: '2.1.0-beta.1', channel: 'beta' });
    execFileSync(process.execPath, [
      'scripts/release-supply-chain.mjs',
      '--version', '2.1.0-beta.1',
      '--commit', 'abc123',
      '--channel', 'beta',
      '--out', 'release/manifest.json',
    ], { cwd: beta });
    expect(readManifest(beta).channel).toBe('beta');
  });
});
