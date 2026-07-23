import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipDistributionName, provisionSkillDependencies } from './provision-deps.js';
import { getSkillNodeModulesDir, getSkillRuntimeDir } from '../paths.js';
import { resetPythonEnvCache } from '../runtime/python-env.js';
import { resetSanitizedEnvCache } from '../capabilities/shell.js';

/**
 * Network-free tests for the skill dependency provisioner. The install paths
 * that actually shell out to npm/pip are proven by the live end-to-end run in
 * the PR description; here we lock the decision logic (skip/idempotency/kinds)
 * and the runtime-integrity contract from Issue #702 that must not regress.
 */
describe('provisionSkillDependencies', () => {
  let prevHome: string | undefined;
  let prevPython: string | undefined;
  let home: string;

  beforeEach(() => {
    prevHome = process.env.MOZI_HOME;
    prevPython = process.env.MOZI_PYTHON;
    home = mkdtempSync(join(tmpdir(), 'mozi-prov-'));
    process.env.MOZI_HOME = home;
    // Interpreter fingerprints are cached per path; tests reuse names across
    // temp dirs, so a stale probe must not leak between cases.
    resetPythonEnvCache();
    resetSanitizedEnvCache();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = prevHome;
    if (prevPython === undefined) delete process.env.MOZI_PYTHON;
    else process.env.MOZI_PYTHON = prevPython;
    resetSanitizedEnvCache();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns an empty result for undefined / empty specs', async () => {
    const empty = { installed: [], ready: [], needsAction: [], failed: [] };
    expect(await provisionSkillDependencies(undefined)).toEqual(empty);
    expect(await provisionSkillDependencies([])).toEqual(empty);
  });

  it('surfaces brew and manual kinds as explicit actions without claiming readiness', async () => {
    const res = await provisionSkillDependencies([
      { kind: 'brew', formula: 'libreoffice', bins: ['__mozi_missing_soffice__'] },
      { kind: 'manual', command: 'do a thing' },
    ]);
    expect(res.installed).toEqual([]);
    expect(res.ready).toEqual([]);
    expect(res.needsAction).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'brew', dependency: 'libreoffice' }),
      expect.objectContaining({ kind: 'manual', dependency: 'do a thing', command: 'do a thing' }),
    ]));
    expect(res.failed).toEqual([]);
  });

  it('treats an npm package as ready only when Node can resolve it', async () => {
    const packageDir = join(getSkillNodeModulesDir(), 'pptxgenjs');
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'pptxgenjs', main: 'index.js' }));
    writeFileSync(join(packageDir, 'index.js'), 'module.exports = {};\n');
    const res = await provisionSkillDependencies([{ kind: 'npm', package: 'pptxgenjs' }]);
    expect(res.ready).toContain('pptxgenjs');
    expect(res.installed).toEqual([]);
    expect(existsSync(join(getSkillNodeModulesDir(), 'pptxgenjs'))).toBe(true);
  });

  it('scopes the runtime dir under MOZI_HOME', () => {
    expect(getSkillRuntimeDir()).toBe(join(home, 'skill-runtime'));
    expect(getSkillNodeModulesDir()).toBe(join(home, 'skill-runtime', 'node_modules'));
  });

  /**
   * Stand-in interpreter answering the three calls the provisioner makes:
   *
   *  - the fingerprint probe (identified by `sysconfig`, which only that script imports);
   *  - `-m pip install ...`, whose argv is appended to a log so the hardening
   *    flags can be asserted directly;
   *  - the import-verification probe, which reports `pkg` importable only once
   *    an install has actually run — modelling the real thing, where a package
   *    does not import until it is installed.
   */
  function fakePython(name: string, opts: { pkg?: string; arch?: string; verify?: string; noise?: string } = {}): string {
    const path = join(home, name);
    const log = `${path}.pip-args.log`;
    const fingerprint = JSON.stringify({
      python_version: '3.11.9',
      implementation: 'cpython',
      abi_tag: 'cp311',
      platform: 'macosx',
      arch: opts.arch ?? 'arm64',
    });
    const shellQuote = (raw: string) => raw.replace(/'/g, `'\\''`);
    const afterInstall = opts.verify ?? JSON.stringify({ healthy: opts.pkg ? [opts.pkg] : [], broken: {} });
    writeFileSync(path, [
      '#!/bin/sh',
      'case "$*" in',
      `  *sysconfig*) printf '%s\\n' '${shellQuote(fingerprint)}' ;;`,
      `  *"pip install"*) printf '%s\\n' "$*" >> '${log}' ;;`,
      // Noise printed before the JSON document, as a package printing a banner
      // or deprecation notice on import would produce.
      `  *) ${opts.noise ? `printf '%s\\n' '${shellQuote(opts.noise)}';` : ''}`,
      `     if [ -f '${log}' ]; then printf '%s\\n' '${shellQuote(afterInstall)}';`,
      `     else printf '%s\\n' '{"healthy":[],"broken":{}}'; fi ;;`,
      'esac',
      '',
    ].join('\n'), 'utf8');
    chmodSync(path, 0o755);
    return path;
  }

  const pipArgs = (interpreter: string): string => {
    const log = `${interpreter}.pip-args.log`;
    return existsSync(log) ? readFileSync(log, 'utf8') : '';
  };

  it('treats a pip spec that already imports under the managed runtime as ready', async () => {
    const python = fakePython('python3', { pkg: 'pypdf' });
    // Pre-seed the log so the stand-in reports pypdf importable from the start.
    writeFileSync(`${python}.pip-args.log`, '', 'utf8');
    process.env.MOZI_PYTHON = python;

    const res = await provisionSkillDependencies([{ kind: 'pip', package: 'pypdf' }]);

    expect(res.ready).toContain('pypdf');
    expect(res.installed).toEqual([]);
    expect(res.failed).toEqual([]);
    // Nothing to do means nothing installed.
    expect(pipArgs(python)).toBe('');
  });

  it('installs into an overlay keyed by interpreter identity, from binary wheels only', async () => {
    const python = fakePython('python3', { pkg: 'pdfminer' });
    process.env.MOZI_PYTHON = python;

    const res = await provisionSkillDependencies([{ kind: 'pip', package: 'pdfminer' }]);

    expect(res.installed).toContain('pdfminer');
    const args = pipArgs(python);
    // Identity in the --target path is what stops an x86_64 tree from ever
    // landing on an arm64 interpreter's import path.
    expect(args).toContain(join(home, 'skill-runtime', 'python', 'cp311-macosx-arm64'));
    // A source build resolves against whatever toolchain the host happens to
    // have; the build-time staging script already forbids it and so must this.
    expect(args).toContain('--only-binary=:all:');
    expect(args).toContain('https://pypi.org/simple');
  });

  it('keeps overlays for different architectures separate', async () => {
    const arm = fakePython('python3-arm', { pkg: 'chardet', arch: 'arm64' });
    process.env.MOZI_PYTHON = arm;
    await provisionSkillDependencies([{ kind: 'pip', package: 'chardet' }]);

    resetPythonEnvCache();
    const intel = fakePython('python3-intel', { pkg: 'chardet', arch: 'x86_64' });
    process.env.MOZI_PYTHON = intel;
    await provisionSkillDependencies([{ kind: 'pip', package: 'chardet' }]);

    // A mixed host (bundled arm64 App plus a Rosetta Miniconda) must keep two
    // individually-valid overlays rather than one tree that poisons whichever
    // interpreter did not build it.
    const root = join(home, 'skill-runtime', 'python');
    expect(pipArgs(arm)).toContain(join(root, 'cp311-macosx-arm64'));
    expect(pipArgs(intel)).toContain(join(root, 'cp311-macosx-x86_64'));
  });

  it('reports a package that installs but fails to import as failed, never installed', async () => {
    // The exact production signature: the wheel is present and its metadata is
    // valid, but the native extension was built for another architecture. A
    // metadata-only check passes this; an import check does not.
    const python = fakePython('python3', {
      verify: JSON.stringify({
        healthy: [],
        broken: { numpy: 'numpy -> ImportError: dlopen(...): incompatible architecture (have x86_64, need arm64)' },
      }),
    });
    process.env.MOZI_PYTHON = python;

    const res = await provisionSkillDependencies([{ kind: 'pip', package: 'numpy' }]);

    expect(res.installed).toEqual([]);
    expect(res.failed.map((f) => f.package)).toContain('numpy');
    expect(res.failed[0]?.error).toMatch(/incompatible architecture/);
  });

  it('preserves a long dlopen diagnostic instead of truncating its own probe output', async () => {
    // The verification probe's stdout is data, not a log line. A single real
    // architecture error exceeds 200 chars; truncating it destroyed exactly the
    // diagnostic this module exists to report, and failed healthy packages that
    // shared the batch.
    const longError = "numpy -> ImportError: dlopen(/Users/x/Library/Application Support/MOZI/skill-runtime/python/cp311-macosx-arm64/numpy/_core/_multiarray_umath.cpython-311-darwin.so, 0x0002): tried: '...' (mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64'))";
    expect(longError.length).toBeGreaterThan(200);
    const python = fakePython('python3', {
      verify: JSON.stringify({ healthy: ['pandas'], broken: { numpy: longError } }),
    });
    process.env.MOZI_PYTHON = python;

    const res = await provisionSkillDependencies([
      { kind: 'pip', package: 'numpy' },
      { kind: 'pip', package: 'pandas' },
    ]);

    const numpyFailure = res.failed.find((f) => f.package === 'numpy');
    expect(numpyFailure?.error).toContain("incompatible architecture (have 'x86_64', need 'arm64')");
    // A long error for one package must not fail the others in the batch.
    expect(res.failed.map((f) => f.package)).not.toContain('pandas');
  });

  it('ignores stray stdout printed on import', async () => {
    // A package that prints a banner/deprecation notice on import would
    // otherwise corrupt the JSON document the probe returns.
    const python = fakePython('python3', {
      pkg: 'idna',
      noise: 'UserWarning: deprecated API',
    });
    process.env.MOZI_PYTHON = python;

    const res = await provisionSkillDependencies([{ kind: 'pip', package: 'idna' }]);

    expect(res.installed).toContain('idna');
    expect(res.failed).toEqual([]);
  });

  it('fails closed with a reason when no interpreter can be fingerprinted', async () => {
    const unusable = join(home, 'python3');
    writeFileSync(unusable, '#!/bin/sh\nexit 1\n');
    chmodSync(unusable, 0o755);
    process.env.MOZI_PYTHON = unusable;

    const res = await provisionSkillDependencies([{ kind: 'pip', package: 'httpx' }]);

    // Never silently install into an unkeyed directory and hope it matches
    // whatever python runs later.
    expect(res.installed).toEqual([]);
    expect(res.ready).not.toContain('httpx');
    expect(res.failed.map((f) => f.package)).toContain('httpx');
  });

  it('normalizes extras and version constraints to distribution names', () => {
    expect(pipDistributionName('markitdown[pptx]==0.1.6')).toBe('markitdown');
    expect(pipDistributionName('Pillow>=12')).toBe('Pillow');
  });
});
