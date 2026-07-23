import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyManagedPythonEnv,
  buildManagedPipEnv,
  computeEnvId,
  getSkillPythonRoot,
  probePythonFingerprint,
  quarantineLegacyPythonRuntime,
  resetPythonEnvCache,
  resolveManagedPythonEnv,
  resolveManagedPythonInterpreter,
  type PythonFingerprint,
} from './python-env.js';

/**
 * Locks the runtime-integrity contract from Issue #702. The production failure
 * was an x86_64 numpy/Pillow tree under a flat `skill-runtime/python` shadowing
 * the bundled arm64 interpreter: both are CPython 3.11, so the `cp311` ABI tag
 * matched and only `dlopen` caught it. These tests pin the properties that make
 * that unrepresentable rather than merely discouraged.
 */
describe('managed python environment identity', () => {
  let prevHome: string | undefined;
  let prevPython: string | undefined;
  let prevPath: string | undefined;
  let home: string;

  const fingerprint = (over: Partial<PythonFingerprint> = {}): PythonFingerprint => ({
    python_version: '3.11.15',
    implementation: 'cpython',
    abi_tag: 'cp311',
    platform: 'macosx',
    arch: 'arm64',
    ...over,
  });

  beforeEach(() => {
    prevHome = process.env.MOZI_HOME;
    prevPython = process.env.MOZI_PYTHON;
    prevPath = process.env.PATH;
    home = mkdtempSync(join(tmpdir(), 'mozi-pyenv-'));
    process.env.MOZI_HOME = home;
    resetPythonEnvCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MOZI_HOME; else process.env.MOZI_HOME = prevHome;
    if (prevPython === undefined) delete process.env.MOZI_PYTHON; else process.env.MOZI_PYTHON = prevPython;
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    rmSync(home, { recursive: true, force: true });
  });

  function stubPython(name: string, body: string): string {
    const path = join(home, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf8');
    chmodSync(path, 0o755);
    return path;
  }

  describe('computeEnvId', () => {
    it('separates identical python versions that differ only by architecture', () => {
      // The precise production case: same interpreter version and ABI tag, one
      // built x86_64 and one arm64. Version alone cannot tell them apart.
      const arm = computeEnvId(fingerprint({ arch: 'arm64' }));
      const intel = computeEnvId(fingerprint({ arch: 'x86_64' }));
      expect(arm).toBe('cp311-macosx-arm64');
      expect(intel).toBe('cp311-macosx-x86_64');
      expect(arm).not.toBe(intel);
    });

    it('ignores patch versions, which share a native ABI', () => {
      expect(computeEnvId(fingerprint({ python_version: '3.11.5' })))
        .toBe(computeEnvId(fingerprint({ python_version: '3.11.15' })));
    });

    it('separates python minor versions and platforms', () => {
      expect(computeEnvId(fingerprint({ abi_tag: 'cp312' }))).toBe('cp312-macosx-arm64');
      expect(computeEnvId(fingerprint({ platform: 'linux' }))).toBe('cp311-linux-arm64');
    });

    it('produces a directory-safe id for unusual implementations', () => {
      const id = computeEnvId(fingerprint({ abi_tag: 'pypy 3.10', platform: 'macosx/x', arch: 'arm 64' }));
      expect(id).toMatch(/^[a-z0-9_-]+$/);
    });
  });

  describe('resolveManagedPythonInterpreter', () => {
    it('prefers the supervisor-provided MOZI_PYTHON over a host PATH interpreter', () => {
      const managed = stubPython('managed', 'exit 0');
      const host = mkdtempSync(join(tmpdir(), 'mozi-hostpy-'));
      try {
        const onPath = join(host, 'python3');
        writeFileSync(onPath, '#!/bin/sh\nexit 0\n');
        chmodSync(onPath, 0o755);
        // A bare `python3` here is what previously fell through to a Miniconda
        // x86_64 interpreter and produced foreign-architecture wheels.
        expect(resolveManagedPythonInterpreter({ MOZI_PYTHON: managed, PATH: host } as NodeJS.ProcessEnv)).toBe(managed);
      } finally {
        rmSync(host, { recursive: true, force: true });
      }
    });

    it('returns null when nothing resolves, rather than a bare command name', () => {
      expect(resolveManagedPythonInterpreter({ PATH: join(home, 'nowhere') } as NodeJS.ProcessEnv)).toBeNull();
    });

    it('ignores a non-executable MOZI_PYTHON', () => {
      const notExec = join(home, 'not-exec');
      writeFileSync(notExec, 'text', 'utf8');
      chmodSync(notExec, 0o644);
      expect(resolveManagedPythonInterpreter({ MOZI_PYTHON: notExec, PATH: join(home, 'nowhere') } as NodeJS.ProcessEnv)).toBeNull();
    });
  });

  describe('probePythonFingerprint', () => {
    it('fails closed rather than guessing an identity', async () => {
      expect(await probePythonFingerprint(stubPython('broken', 'exit 1'))).toBeNull();
      expect(await probePythonFingerprint(stubPython('garbage', "printf 'not json\\n'"))).toBeNull();
    });

    it('reads a real interpreter and yields a usable env id', async () => {
      const python = stubPython('good', `printf '%s\\n' '${JSON.stringify(fingerprint())}'`);
      const fp = await probePythonFingerprint(python);
      expect(fp).toMatchObject({ abi_tag: 'cp311', arch: 'arm64' });
      expect(computeEnvId(fp!)).toBe('cp311-macosx-arm64');
    });

    it('rejects an incomplete fingerprint rather than deriving an id from it', async () => {
      // A partial response reaching computeEnvId would throw out of the
      // provisioner, which must never break use_skill.
      const python = stubPython('partial', `printf '%s\\n' '{"abi_tag":"cp311","arch":"arm64"}'`);
      expect(await probePythonFingerprint(python)).toBeNull();
    });

    it('does not cache a transient failure', async () => {
      // A timeout under load or an EAGAIN would otherwise disable python for the
      // whole process: nothing in production invalidates this cache.
      const path = join(home, 'flaky');
      const marker = join(home, 'probe-attempted');
      writeFileSync(path, [
        '#!/bin/sh',
        `if [ -f '${marker}' ]; then printf '%s\\n' '${JSON.stringify(fingerprint())}'; else : > '${marker}'; exit 1; fi`,
        '',
      ].join('\n'), 'utf8');
      chmodSync(path, 0o755);

      expect(await probePythonFingerprint(path)).toBeNull();
      // Second attempt must actually re-probe, not replay the cached failure.
      expect(await probePythonFingerprint(path)).toMatchObject({ arch: 'arm64' });
    });

    it('does not accept a directory as an interpreter', () => {
      // X_OK alone succeeds on directories, so a `python3` directory on PATH
      // would resolve as an executable and then fail at spawn.
      mkdirSync(join(home, 'bin', 'python3'), { recursive: true });
      expect(resolveManagedPythonInterpreter({ PATH: join(home, 'bin') } as NodeJS.ProcessEnv)).toBeNull();
    });
  });

  describe('resolveManagedPythonEnv', () => {
    it('keys the overlay directory under the python root by identity', async () => {
      const python = stubPython('python3', `printf '%s\\n' '${JSON.stringify(fingerprint())}'`);
      const env = await resolveManagedPythonEnv({ MOZI_PYTHON: python, PATH: home } as NodeJS.ProcessEnv);
      expect(env?.envId).toBe('cp311-macosx-arm64');
      expect(env?.envDir).toBe(join(getSkillPythonRoot(), 'cp311-macosx-arm64'));
      expect(env?.interpreter).toBe(python);
    });

    it('returns null when the interpreter cannot be fingerprinted', async () => {
      const python = stubPython('python3', 'exit 1');
      expect(await resolveManagedPythonEnv({ MOZI_PYTHON: python, PATH: home } as NodeJS.ProcessEnv)).toBeNull();
    });
  });

  describe('applyManagedPythonEnv', () => {
    it('replaces an inherited PYTHONPATH instead of appending to it', () => {
      // Appending is what let a host virtualenv/conda tree stay on the import
      // path alongside the managed overlay.
      const out = applyManagedPythonEnv({ PATH: '/bin', PYTHONPATH: '/host/site-packages' }, '/managed/cp311-macosx-arm64');
      expect(out.PYTHONPATH).toBe('/managed/cp311-macosx-arm64');
      expect(out.PYTHONPATH).not.toContain('/host/site-packages');
    });

    it('clears PYTHONHOME and VIRTUAL_ENV and disables user site-packages', () => {
      const out = applyManagedPythonEnv(
        { PATH: '/bin', PYTHONHOME: '/host/py', VIRTUAL_ENV: '/host/venv' },
        '/managed/cp311-macosx-arm64',
      );
      expect(out.PYTHONHOME).toBeUndefined();
      expect(out.VIRTUAL_ENV).toBeUndefined();
      expect(out.PYTHONNOUSERSITE).toBe('1');
    });

    it('drops PYTHONPATH entirely when there is no overlay', () => {
      const out = applyManagedPythonEnv({ PATH: '/bin', PYTHONPATH: '/host/site-packages' }, null);
      expect(out.PYTHONPATH).toBeUndefined();
    });

    it('leads PATH with the managed interpreter when PATH would resolve another one', () => {
      // The overlay is keyed to the resolved interpreter, but a bare `python3`
      // resolves through PATH independently. Set MOZI_PYTHON without leading PATH
      // with it and a command gets an arm64 overlay on an x86_64 interpreter —
      // the original bug, from the other side.
      const managedBin = join(home, 'bin');
      const managed = join(managedBin, 'python3');
      mkdirSync(managedBin, { recursive: true });
      writeFileSync(managed, '#!/bin/sh\n', 'utf8');
      chmodSync(managed, 0o755);
      const hostBin = join(home, 'hostbin');
      mkdirSync(hostBin, { recursive: true });
      const hostPython = join(hostBin, 'python3');
      writeFileSync(hostPython, '#!/bin/sh\n', 'utf8');
      chmodSync(hostPython, 0o755);

      const out = applyManagedPythonEnv({ PATH: hostBin }, '/managed/cp311-macosx-arm64', managed);
      expect(out.PATH.split(':')[0]).toBe(managedBin);
    });

    it('leaves PATH untouched when it already resolves the managed interpreter', () => {
      // The packaged App already leads PATH with the bundled interpreter, and a
      // dev run found python3 on PATH to begin with. Hoisting the directory
      // anyway would shadow the user's own pip/f2py/markitdown for every command.
      const hostBin = join(home, 'hostbin2');
      mkdirSync(hostBin, { recursive: true });
      const hostPython = join(hostBin, 'python3');
      writeFileSync(hostPython, '#!/bin/sh\n', 'utf8');
      chmodSync(hostPython, 0o755);
      const originalPath = `/opt/tools:${hostBin}`;

      const out = applyManagedPythonEnv({ PATH: originalPath }, '/managed/cp311-macosx-arm64', hostPython);
      expect(out.PATH).toBe(originalPath);
    });

    it('does not mutate the caller env', () => {
      const base = { PATH: '/bin', PYTHONPATH: '/host' };
      applyManagedPythonEnv(base, '/managed');
      expect(base.PYTHONPATH).toBe('/host');
    });
  });

  describe('buildManagedPipEnv', () => {
    it('ignores host pip configuration', () => {
      // A mirror in ~/.pip/pip.conf and stray PIP_* vars are what pulled in
      // wheels that did not match the interpreter.
      const out = buildManagedPipEnv('/managed/cp311-macosx-arm64', {
        PATH: '/bin',
        PIP_INDEX_URL: 'https://mirrors.example.com/pypi/simple',
        PIP_NO_BINARY: ':all:',
      } as NodeJS.ProcessEnv);
      expect(out.PIP_CONFIG_FILE).toBe('/dev/null');
      expect(out.PIP_INDEX_URL).toBeUndefined();
      expect(out.PIP_NO_BINARY).toBeUndefined();
      expect(out.PYTHONPATH).toBe('/managed/cp311-macosx-arm64');
    });
  });

  describe('quarantineLegacyPythonRuntime', () => {
    it('moves aside an unkeyed flat tree, preserving its contents', () => {
      // Reproduces the shape found on the affected machine: packages installed
      // directly into the root by `pip install --target`.
      const root = getSkillPythonRoot();
      mkdirSync(join(root, 'numpy'), { recursive: true });
      mkdirSync(join(root, 'numpy-2.4.6.dist-info'), { recursive: true });
      writeFileSync(join(root, 'numpy', 'marker.so'), 'x86_64', 'utf8');

      const result = quarantineLegacyPythonRuntime(() => new Date('2026-07-15T21:16:24Z'));

      expect(result.quarantined).toBe(true);
      // Renamed, never deleted: the data home may hold deliberate work and the
      // Issue forbids destructive cleanup.
      expect(existsSync(join(result.movedTo!, 'numpy', 'marker.so'))).toBe(true);
      expect(existsSync(root)).toBe(true);
      expect(readdirSync(root)).toEqual([]);
    });

    it('leaves an identity-keyed layout untouched', () => {
      const root = getSkillPythonRoot();
      mkdirSync(join(root, 'cp311-macosx-arm64', 'numpy-2.3.5.dist-info'), { recursive: true });

      expect(quarantineLegacyPythonRuntime().quarantined).toBe(false);
      expect(existsSync(join(root, 'cp311-macosx-arm64'))).toBe(true);
    });

    it('is a no-op when nothing has been provisioned', () => {
      expect(quarantineLegacyPythonRuntime().quarantined).toBe(false);
    });

    it('is idempotent across repeated startups', () => {
      const root = getSkillPythonRoot();
      mkdirSync(join(root, 'numpy-2.4.6.dist-info'), { recursive: true });
      expect(quarantineLegacyPythonRuntime(() => new Date('2026-07-15T21:16:24Z')).quarantined).toBe(true);
      // Second boot sees a clean root and must not churn.
      expect(quarantineLegacyPythonRuntime(() => new Date('2026-07-15T21:17:00Z')).quarantined).toBe(false);
    });
  });
});
