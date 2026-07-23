import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDesktopPath } from './environment.js';

describe('desktop runtime environment', () => {
  it('prepends existing user tool directories and removes duplicates', () => {
    const home = mkdtempSync(join(tmpdir(), 'mozi-desktop-path-'));
    try {
      mkdirSync(join(home, 'miniconda3', 'bin'), { recursive: true });
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      const path = buildDesktopPath(['/usr/bin', join(home, '.local', 'bin'), '/bin'].join(delimiter), home).split(delimiter);

      expect(path[0]).toBe(join(home, 'miniconda3', 'bin'));
      expect(path).toContain('/usr/bin');
      expect(path).toContain('/bin');
      expect(path.filter((entry) => entry === join(home, '.local', 'bin'))).toHaveLength(1);
      expect(path).not.toContain(process.cwd());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
