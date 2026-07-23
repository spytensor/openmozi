import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildDesktopCapabilitySnapshot, resolveExecutable } from './desktop-capabilities.js';

describe('desktop capability snapshot', () => {
  it('resolves only executable files from the supplied PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'mozi-capabilities-'));
    try {
      mkdirSync(join(root, 'bin'));
      const executable = join(root, 'bin', 'tool');
      writeFileSync(executable, '#!/bin/sh\n');
      chmodSync(executable, 0o755);
      expect(resolveExecutable('tool', join(root, 'bin'))).toBe(executable);
      expect(resolveExecutable('missing', join(root, 'bin'))).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports unavailable enhancements and an explicit Office fallback', async () => {
    const snapshot = await buildDesktopCapabilitySnapshot({
      env: { PATH: '/missing', MOZI_DESKTOP: '1' } as NodeJS.ProcessEnv,
      probe: vi.fn(async () => false),
      fetchImpl: vi.fn(),
    });

    expect(snapshot.desktop_mode).toBe(true);
    expect(snapshot.native.document_generation).toBe(false);
    expect(snapshot.managed_workers).not.toHaveProperty('gemini');
    expect(snapshot.enhanced.docker.available).toBe(false);
    expect(snapshot.enhanced.office).toMatchObject({ configured: false, available: false, mode: 'fallback', reason: 'not_configured' });
  });

  it('probes the explicit managed Python instead of a host PATH interpreter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mozi-managed-python-'));
    try {
      const managedPython = join(root, 'managed-python3');
      writeFileSync(managedPython, '#!/bin/sh\n');
      chmodSync(managedPython, 0o755);
      const probe = vi.fn(async () => true);

      const snapshot = await buildDesktopCapabilitySnapshot({
        env: { PATH: '/host/miniconda/bin', MOZI_PYTHON: managedPython, MOZI_DESKTOP: '1' } as NodeJS.ProcessEnv,
        probe,
        fetchImpl: vi.fn(),
      });

      expect(snapshot.native.binaries.python3).toBe(managedPython);
      // The probe now also receives the environment it must run under: readiness
      // has to execute the same environment as shell_exec, or the two can
      // disagree about what python can import (Issue #702 root cause 4).
      expect(probe).toHaveBeenCalledWith(managedPython, expect.any(Array), 20_000, expect.any(Object));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows Python cold imports more time without widening lightweight probes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mozi-capability-timeouts-'));
    try {
      for (const binary of ['python3', 'soffice', 'pdftoppm', 'docker', 'codex', 'claude', 'gemini']) {
        const path = join(root, binary);
        writeFileSync(path, '#!/bin/sh\n');
        chmodSync(path, 0o755);
      }
      const probe = vi.fn(async () => true);
      await buildDesktopCapabilitySnapshot({
        env: { PATH: root, MOZI_DESKTOP: '1' } as NodeJS.ProcessEnv,
        probe,
        fetchImpl: vi.fn(async () => ({ ok: false }) as Response),
      });

      expect(probe.mock.calls.find(([command]) => command === join(root, 'python3'))?.[2]).toBe(20_000);
      expect(probe.mock.calls.find(([command]) => command === join(root, 'soffice'))?.[2]).toBe(5_000);
      expect(probe.mock.calls.some(([command]) => command === join(root, 'gemini'))).toBe(false);
      expect(probe.mock.calls.filter(([command]) => ![join(root, 'python3'), join(root, 'soffice')].includes(command)).every(([, , timeout]) => timeout === 3_000)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('finishes the Python cold probe before launching other tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mozi-capability-order-'));
    try {
      for (const binary of ['python3', 'soffice', 'pdftoppm']) {
        const path = join(root, binary);
        writeFileSync(path, '#!/bin/sh\n');
        chmodSync(path, 0o755);
      }
      const calls: string[] = [];
      let releasePython!: () => void;
      const pythonGate = new Promise<void>((resolve) => { releasePython = resolve; });
      const snapshot = buildDesktopCapabilitySnapshot({
        env: { PATH: root, MOZI_DESKTOP: '1' } as NodeJS.ProcessEnv,
        probe: async (command) => {
          const name = command.split('/').at(-1)!;
          calls.push(`${name}:start`);
          if (name === 'python3') await pythonGate;
          calls.push(`${name}:end`);
          return true;
        },
        fetchImpl: vi.fn(async () => ({ ok: false }) as Response),
      });

      // The snapshot fingerprints the managed interpreter (spawning it) before
      // any capability probe runs, so first contact is not immediate; the
      // default 1s window can expire under parallel suite load.
      await vi.waitFor(() => expect(calls).toEqual(['python3:start']), { timeout: 15_000 });
      releasePython();
      await snapshot;
      expect(calls.indexOf('python3:end')).toBeLessThan(calls.indexOf('soffice:start'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
