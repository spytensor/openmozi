import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findProjectRootFrom, getRuntimeProjectRoot, resolveFromProjectRoot, resolveProjectRelativePath } from './project-root.js';

describe('runtime/project-root', () => {
  it('resolves the repository root from the runtime module location', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    expect(findProjectRootFrom(testDir)).toBe(getRuntimeProjectRoot());
  });

  it('finds the repository root from a bundled dist entry path', () => {
    const bundledDir = resolve(getRuntimeProjectRoot(), 'dist');
    expect(findProjectRootFrom(bundledDir)).toBe(getRuntimeProjectRoot());
  });

  it('resolves project-relative paths from the repository root', () => {
    expect(resolveFromProjectRoot('bootstrap')).toBe(resolve(getRuntimeProjectRoot(), 'bootstrap'));
    expect(resolveProjectRelativePath('src/index.ts')).toBe(resolve(getRuntimeProjectRoot(), 'src/index.ts'));
  });

  it('passes through absolute paths', () => {
    const absolute = '/tmp/mozi-project-root-test';
    expect(resolveProjectRelativePath(absolute)).toBe(absolute);
  });

  it('honors MOZI_PROJECT_ROOT override', () => {
    const previous = process.env.MOZI_PROJECT_ROOT;
    process.env.MOZI_PROJECT_ROOT = '/tmp/mozi-project-root-override';
    try {
      expect(getRuntimeProjectRoot()).toBe('/tmp/mozi-project-root-override');
    } finally {
      if (previous === undefined) {
        delete process.env.MOZI_PROJECT_ROOT;
      } else {
        process.env.MOZI_PROJECT_ROOT = previous;
      }
    }
  });
});
