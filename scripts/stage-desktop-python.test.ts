import { mkdtempSync, mkdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { copyStandalonePython, pythonAssetFor } from './stage-desktop-python.mjs';

describe('desktop managed Python staging contract', () => {
  it('pins architecture-specific standalone archives and checksums', () => {
    const arm = pythonAssetFor('3.11.15', '20260510', 'arm64');
    const intel = pythonAssetFor('3.11.15', '20260510', 'x64');

    expect(arm.fileName).toContain('aarch64-apple-darwin-install_only_stripped');
    expect(arm.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(intel.fileName).toContain('x86_64-apple-darwin-install_only_stripped');
    expect(intel.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(arm.url).toContain('20260510');
  });

  it('fails closed for an unpinned Python artifact', () => {
    expect(() => pythonAssetFor('3.13.0', '20990101', 'arm64')).toThrow('No pinned SHA256');
  });

  it('preserves relative interpreter symlinks when moving out of the build directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'mozi-python-copy-'));
    try {
      const source = join(root, 'source');
      const destination = join(root, 'destination');
      mkdirSync(join(source, 'bin'), { recursive: true });
      writeFileSync(join(source, 'bin', 'python3.11'), 'binary');
      symlinkSync('python3.11', join(source, 'bin', 'python3'));

      copyStandalonePython(source, destination);

      expect(readlinkSync(join(destination, 'bin', 'python3'))).toBe('python3.11');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
