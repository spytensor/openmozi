import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain .mjs module without type declarations
import { isExcluded, withTargetVersion } from './export-public.mjs';

const EXPORT_SCRIPT = join(process.cwd(), 'scripts/export-public.mjs');
const VERIFIER = join(process.cwd(), 'scripts/verify-public-export.mjs');

function git(cwd: string, args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args],
    { cwd, encoding: 'utf8' },
  );
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

describe('public export policy helpers', () => {
  it('excludes exact paths and directory prefixes only', () => {
    const patterns = ['IMPLEMENTATION.md', 'requirements/'];
    expect(isExcluded('IMPLEMENTATION.md', patterns)).toBe(true);
    expect(isExcluded('requirements/dev.txt', patterns)).toBe(true);
    expect(isExcluded('docs/IMPLEMENTATION.md', patterns)).toBe(false);
    expect(isExcluded('requirements-notes.md', patterns)).toBe(false);
    expect(isExcluded('src/app.ts', patterns)).toBe(false);
  });

  it('rewrites only the version field and keeps source text otherwise', () => {
    const src = '{\n  "name": "mozi",\n  "version": "2.13.0",\n  "private": true\n}\n';
    expect(withTargetVersion(src, '1.0.0')).toContain('"version": "1.0.0"');
    expect(withTargetVersion(src, '1.0.0')).toContain('"name": "mozi"');
    expect(withTargetVersion(src, null)).toBe(src);
  });
});

describe('export-public end to end', () => {
  const stage = mkdtempSync(join(tmpdir(), 'export-public-test-'));
  afterAll(() => rmSync(stage, { recursive: true, force: true }));

  it('mirrors the tracked tree, applies policy, and passes the privacy gate', () => {
    const source = join(stage, 'source');
    const target = join(stage, 'target');
    mkdirSync(source);
    mkdirSync(target);

    // Source repo: the "internal" tree, including files that must not go public.
    git(source, ['init', '-q']);
    write(source, 'README.md', '# OpenMozi\n');
    write(source, 'IMPLEMENTATION.md', 'internal tracking\n');
    write(source, 'package.json', '{\n  "name": "mozi",\n  "version": "9.9.9"\n}\n');
    write(source, 'src/app.ts', 'export const app = 1;\n');
    write(source, 'requirements/dev.txt', 'internal\n');
    write(source, 'CHANGELOG.md', 'internal changelog\n');
    mkdirSync(join(source, 'scripts'), { recursive: true });
    copyFileSync(VERIFIER, join(source, 'scripts/verify-public-export.mjs'));
    write(source, 'untracked-secret.txt', 'never committed, must never export\n');
    git(source, ['add', 'README.md', 'IMPLEMENTATION.md', 'package.json', 'src/app.ts', 'requirements/dev.txt', 'CHANGELOG.md', 'scripts/verify-public-export.mjs']);
    git(source, ['commit', '-q', '-m', 'source tree']);

    // Target repo: the existing public repo with its own version line and changelog.
    git(target, ['init', '-q']);
    write(target, 'CHANGELOG.md', 'public changelog\n');
    write(target, 'package.json', '{\n  "name": "mozi",\n  "version": "1.0.0"\n}\n');
    write(target, 'stale.txt', 'removed upstream\n');
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', 'previous public snapshot']);

    const config = join(stage, 'config.json');
    writeFileSync(
      config,
      JSON.stringify({
        exclude: ['IMPLEMENTATION.md', 'requirements/'],
        preserveTarget: ['CHANGELOG.md'],
        preserveTargetVersion: ['package.json'],
      }),
    );

    const output = execFileSync(
      'node',
      [EXPORT_SCRIPT, '--target', target, '--config', config, '--commit'],
      { cwd: source, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e.st', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e.st' } },
    );

    const targetFiles = git(target, ['ls-files']).split('\n').filter(Boolean);
    expect(targetFiles).toContain('README.md');
    expect(targetFiles).toContain('src/app.ts');
    expect(targetFiles).not.toContain('IMPLEMENTATION.md');
    expect(targetFiles).not.toContain('requirements/dev.txt');
    expect(targetFiles).not.toContain('stale.txt');
    expect(targetFiles).not.toContain('untracked-secret.txt');

    expect(readFileSync(join(target, 'CHANGELOG.md'), 'utf8')).toBe('public changelog\n');
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    expect(pkg.version).toBe('1.0.0');

    // The operator's own console may name the source version; the published
    // commit message may not — it is read by people with no access to it.
    expect(output).toContain('internal v9.9.9');
    const publishedSubject = git(target, ['log', '-1', '--format=%s']);
    expect(publishedSubject).toContain('sync: update public tree for v1.0.0');
    expect(publishedSubject).not.toMatch(/9\.9\.9|MOZI|internal/i);
    expect(git(target, ['status', '--porcelain']).trim()).toBe('');
  });

  it('fails closed: a privacy violation blocks the commit', () => {
    const source = join(stage, 'source3');
    const target = join(stage, 'target3');
    mkdirSync(source);
    mkdirSync(target);

    git(source, ['init', '-q']);
    write(source, 'README.md', '# ok\n');
    write(source, 'package.json', '{\n  "name": "mozi",\n  "version": "9.9.9"\n}\n');
    // Build the owner path dynamically — a literal would trip the privacy gate
    // on this test file itself.
    const ownerPath = '/Users/' + ['zhu', 'chaojie'].join('') + '/secret-notes.txt';
    write(source, 'docs/leak.md', `see ${ownerPath}\n`);
    mkdirSync(join(source, 'scripts'), { recursive: true });
    copyFileSync(VERIFIER, join(source, 'scripts/verify-public-export.mjs'));
    git(source, ['add', '-A']);
    git(source, ['commit', '-q', '-m', 'tree with a violation']);

    git(target, ['init', '-q']);
    write(target, 'README.md', 'old\n');
    git(target, ['add', '-A']);
    git(target, ['commit', '-q', '-m', 'public baseline']);

    const config = join(stage, 'config3.json');
    writeFileSync(config, JSON.stringify({ exclude: [] }));

    expect(() =>
      execFileSync('node', [EXPORT_SCRIPT, '--target', target, '--config', config, '--commit'], {
        cwd: source,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();

    // No commit was made; the violating sync is left staged for inspection.
    expect(git(target, ['rev-list', '--count', 'HEAD']).trim()).toBe('1');
    expect(git(target, ['log', '-1', '--format=%s'])).toContain('public baseline');
    expect(git(target, ['diff', '--cached', '--name-only'])).toContain('docs/leak.md');
  });

  it('refuses a dirty target and leaves it untouched', () => {
    const source = join(stage, 'source2');
    const target = join(stage, 'target2');
    mkdirSync(source);
    mkdirSync(target);
    git(source, ['init', '-q']);
    write(source, 'README.md', 'x\n');
    git(source, ['add', '-A']);
    git(source, ['commit', '-q', '-m', 'init']);
    git(target, ['init', '-q']);
    write(target, 'dirty.txt', 'uncommitted\n');

    const config = join(stage, 'config2.json');
    writeFileSync(config, JSON.stringify({ exclude: [] }));

    expect(() =>
      execFileSync('node', [EXPORT_SCRIPT, '--target', target, '--config', config], {
        cwd: source,
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow(/not clean/);
    expect(readFileSync(join(target, 'dirty.txt'), 'utf8')).toBe('uncommitted\n');
  });
});
