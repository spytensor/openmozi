/**
 * Skill dependency provisioner.
 *
 * Skills declare runtime dependencies in their `install:` frontmatter (npm / pip
 * packages). Historically that manifest was parsed but never acted on, so any
 * skill needing an external library (pptxgenjs, docx, openpyxl, ...) crashed on
 * first use with "Cannot find module" / "ModuleNotFoundError". This module makes
 * the manifest live: when a skill is activated we install its declared packages
 * into a shared runtime dir (`<moziHome>/skill-runtime`). npm packages go on
 * NODE_PATH; pip packages go into an interpreter-identity-keyed overlay that is
 * placed on PYTHONPATH for shell commands (see capabilities/shell.ts and
 * runtime/python-env.ts).
 *
 * Design notes:
 * - Identity-keyed: pip packages are installed into the overlay belonging to the
 *   *pinned* managed interpreter, never a bare `python3` picked off PATH. A tree
 *   built by a foreign-architecture interpreter therefore cannot end up on the
 *   managed interpreter's import path.
 * - Verified, not assumed: an install is only recorded once the packages
 *   actually *import* under the effective environment. Distribution metadata is
 *   not evidence — an x86_64 wheel on an arm64 interpreter reports a valid
 *   version and still fails at dlopen.
 * - Hardened: binary wheels only, host pip configuration ignored. This mirrors
 *   the build-time contract in scripts/stage-desktop-python.mjs, which was
 *   already hardened while this runtime path was not.
 * - Best-effort: install failures are logged and returned, never thrown — a
 *   provisioning miss must not break `use_skill` itself. Failures are reported
 *   rather than silently leaving a partially-installed overlay marked ready.
 * - Serialized: concurrent activations share one in-flight install chain to
 *   avoid two npm/pip writers racing on the same prefix.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pino from 'pino';
import { getSkillRuntimeDir, getSkillNodeModulesDir } from '../paths.js';
import {
  buildManagedPipEnv,
  managedPipIndexUrl,
  readEnvManifest,
  resolveManagedPythonEnv,
  writeEnvManifest,
  type ManagedPythonEnv,
} from '../runtime/python-env.js';
import type { SkillInstallSpec } from './loader.js';

const logger = pino({ name: 'mozi:skills:provision' });

/** Max wall-clock for a single npm/pip install batch. */
const INSTALL_TIMEOUT_MS = 180_000;

export interface ProvisionResult {
  installed: string[];
  /** Dependencies that were already present and passed their runtime probe. */
  ready: string[];
  /** Dependencies the managed runtime cannot install without an explicit
   * operator/system action. These are never described as ready. */
  needsAction: Array<{
    kind: 'brew' | 'manual';
    dependency: string;
    bins: string[];
    command?: string;
    label?: string;
  }>;
  failed: Array<{ package: string; error: string }>;
}

/** In-process record of specs already provisioned this run (fast path). */
const provisionedThisRun = new Set<string>();
/** Serialize install batches so two activations don't race the same prefix. */
let installChain: Promise<unknown> = Promise.resolve();

/** npm package base dir name (strip any version/range: `foo@1.2` -> `foo`, keep scope). */
function npmDirName(pkg: string): string {
  const at = pkg.lastIndexOf('@');
  return at > 0 ? pkg.slice(0, at) : pkg;
}

function dependencyLabel(spec: SkillInstallSpec): string {
  return spec.package || spec.formula || spec.command || spec.label || spec.kind;
}

async function verifyBins(bins: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  if (bins.length === 0) return false;
  for (const bin of bins) {
    const probe = await run('which', [bin], env);
    if (!probe.ok) return false;
  }
  return true;
}

function ensureRuntimeDir(pythonEnvDir?: string): void {
  const dir = getSkillRuntimeDir();
  mkdirSync(dir, { recursive: true });
  const pkgJson = join(dir, 'package.json');
  if (!existsSync(pkgJson)) {
    // A private package.json stops npm from walking up to install elsewhere.
    writeFileSync(pkgJson, JSON.stringify({ name: 'mozi-skill-runtime', private: true }, null, 2), 'utf8');
  }
  if (pythonEnvDir) mkdirSync(pythonEnvDir, { recursive: true });
}

/**
 * Run a command for its exit status, with output truncated for logging.
 *
 * The truncation is a log-safety measure — do NOT use this when stdout is data
 * (see `runJson`).
 */
function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        resolvePromise({ ok: false, output: `${stderr || ''}${err.message}`.slice(0, 500) });
      } else {
        resolvePromise({ ok: true, output: (stdout || '').slice(0, 200) });
      }
    });
  });
}

/**
 * Run a command whose stdout is a JSON document, returning it untruncated.
 *
 * Separate from `run` because that helper slices stdout to 200 characters for
 * logging. A single dlopen error ("incompatible architecture (have 'x86_64',
 * need 'arm64')") already exceeds that, so parsing `run`'s output silently
 * destroyed exactly the diagnostic this module exists to report — and, because
 * a parse failure fails the whole batch, healthy packages sharing the batch were
 * reported broken too.
 *
 * Only the last stdout line is parsed: a package that prints on import (a
 * deprecation notice, a banner) would otherwise corrupt the document.
 */
function runJson(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ ok: boolean; value?: unknown; output: string }> {
  return new Promise((resolvePromise) => {
    execFile(cmd, args, { timeout: INSTALL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) {
        resolvePromise({ ok: false, output: `${stderr || ''}${err.message}`.slice(0, 500) });
        return;
      }
      const lines = (stdout || '').trim().split('\n');
      const last = lines[lines.length - 1] ?? '';
      try {
        resolvePromise({ ok: true, value: JSON.parse(last), output: last.slice(0, 500) });
      } catch {
        resolvePromise({ ok: false, output: `unparseable probe output: ${last.slice(0, 400)}` });
      }
    });
  });
}

export function pipDistributionName(spec: string): string {
  return spec.trim().match(/^[A-Za-z0-9][A-Za-z0-9._-]*/)?.[0] ?? spec.trim();
}

/**
 * Check that pip specs are installed *and importable* under a managed environment.
 *
 * A distribution name is not an import name (`Pillow` provides `PIL`,
 * `python-docx` provides `docx`), so the interpreter is asked to resolve each
 * distribution's real top-level modules from its own metadata and then import
 * them. A spec counts as broken only when every one of its top-level modules
 * fails, which is exactly the signature of an architecture mismatch while
 * tolerating distributions that ship optional/auxiliary top-levels.
 *
 * This replaces a metadata-only `importlib.metadata.version()` check, which an
 * x86_64 wheel on an arm64 interpreter passes cleanly before failing at dlopen.
 */
async function verifyPipSpecs(
  env: ManagedPythonEnv,
  specs: string[],
): Promise<{ healthy: Set<string>; broken: Map<string, string> }> {
  const healthy = new Set<string>();
  const broken = new Map<string, string>();
  if (specs.length === 0) return { healthy, broken };

  const script = [
    'import importlib, importlib.metadata as metadata, json, sys',
    'pairs = json.loads(sys.argv[1])',
    'healthy, broken = [], {}',
    'for spec, dist_name in pairs:',
    '    try:',
    '        dist = metadata.distribution(dist_name)',
    '    except Exception as exc:',
    '        broken[spec] = "not installed: %s" % exc',
    '        continue',
    '    modules = []',
    '    try:',
    '        listed = dist.read_text("top_level.txt") or ""',
    '        modules = [line.strip() for line in listed.splitlines() if line.strip()]',
    '    except Exception:',
    '        modules = []',
    '    if not modules:',
    '        modules = [dist_name.replace("-", "_")]',
    '    errors = []',
    '    for module in modules:',
    '        try:',
    '            importlib.import_module(module)',
    '        except BaseException as exc:',
    '            errors.append("%s -> %s: %s" % (module, type(exc).__name__, exc))',
    '    if errors and len(errors) == len(modules):',
    '        broken[spec] = "; ".join(errors)',
    '    else:',
    '        healthy.append(spec)',
    'print(json.dumps({"healthy": healthy, "broken": broken}))',
  ].join('\n');

  const pairs = specs.map((spec) => [spec, pipDistributionName(spec)]);
  const probe = await runJson(env.interpreter, ['-c', script, JSON.stringify(pairs)], buildManagedPipEnv(env.envDir, process.env, env.interpreter));
  const parsed = probe.ok ? (probe.value as { healthy?: unknown; broken?: unknown }) : undefined;
  if (!Array.isArray(parsed?.healthy) || !parsed?.broken || typeof parsed.broken !== 'object') {
    // Unknown state is not healthy: report every spec broken with the reason so
    // the caller fails closed instead of exposing an unverified capability.
    for (const spec of specs) broken.set(spec, `verification probe failed: ${probe.output}`);
    logger.warn({ interpreter: env.interpreter, output: probe.output }, 'could not verify skill pip dependencies');
    return { healthy, broken };
  }
  for (const spec of parsed.healthy) if (typeof spec === 'string') healthy.add(spec);
  for (const [spec, reason] of Object.entries(parsed.broken as Record<string, unknown>)) {
    broken.set(spec, String(reason));
  }
  return { healthy, broken };
}

/** npm gets the same verified-readiness treatment as pip. A directory under
 * node_modules is not proof that the package resolves (partial installs and
 * stale directories are common after interrupted writes). */
async function verifyNpmSpecs(
  specs: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ healthy: Set<string>; broken: Map<string, string> }> {
  const healthy = new Set<string>();
  const broken = new Map<string, string>();
  if (specs.length === 0) return { healthy, broken };

  const script = [
    'const pairs = JSON.parse(process.argv[1]);',
    'const healthy = []; const broken = {};',
    'for (const [spec, moduleName] of pairs) {',
    '  try { require.resolve(moduleName); healthy.push(spec); }',
    '  catch (err) { broken[spec] = String(err && err.message || err); }',
    '}',
    'process.stdout.write(JSON.stringify({ healthy, broken }));',
  ].join('\n');
  const pairs = specs.map(spec => [spec, npmDirName(spec)]);
  const probe = await runJson(process.execPath, ['-e', script, JSON.stringify(pairs)], env);
  const parsed = probe.ok ? (probe.value as { healthy?: unknown; broken?: unknown }) : undefined;
  if (!Array.isArray(parsed?.healthy) || !parsed?.broken || typeof parsed.broken !== 'object') {
    for (const spec of specs) broken.set(spec, `verification probe failed: ${probe.output}`);
    return { healthy, broken };
  }
  for (const spec of parsed.healthy) if (typeof spec === 'string') healthy.add(spec);
  for (const [spec, reason] of Object.entries(parsed.broken as Record<string, unknown>)) {
    broken.set(spec, String(reason));
  }
  return { healthy, broken };
}

/**
 * Provision the npm/pip dependencies declared by a skill's `install:` manifest.
 * `brew` / `manual` kinds are never auto-run; they are probed and surfaced as
 * explicit operator actions when unavailable.
 */
export async function provisionSkillDependencies(
  specs: SkillInstallSpec[] | undefined,
): Promise<ProvisionResult> {
  const result: ProvisionResult = { installed: [], ready: [], needsAction: [], failed: [] };
  if (!specs || specs.length === 0) return result;

  const { getManagedShellEnv } = await import('../capabilities/shell.js');
  const executionEnv = await getManagedShellEnv();
  const npmCandidates: string[] = [];
  const pipCandidates: string[] = [];
  for (const spec of specs) {
    if (spec.kind === 'brew' || spec.kind === 'manual') {
      const bins = spec.bins ?? [];
      if (await verifyBins(bins, executionEnv)) {
        result.ready.push(dependencyLabel(spec));
      } else {
        result.needsAction.push({
          kind: spec.kind,
          dependency: dependencyLabel(spec),
          bins,
          ...(spec.command ? { command: spec.command } : {}),
          ...(spec.label ? { label: spec.label } : {}),
        });
      }
      continue;
    }
    if (!spec.package) {
      result.failed.push({ package: dependencyLabel(spec), error: `${spec.kind} dependency is missing package` });
      continue;
    }
    const key = `${spec.kind}:${spec.package}`;
    if (spec.kind === 'npm') {
      if (provisionedThisRun.has(key)) result.ready.push(spec.package);
      else npmCandidates.push(spec.package);
    } else if (spec.kind === 'pip') {
      // Deliberately not consulting provisionedThisRun yet: pip cache keys are
      // scoped to the resolved environment's identity, which is not known until
      // the interpreter is fingerprinted below.
      pipCandidates.push(spec.package);
    }
  }

  const npmPkgs: string[] = [];
  if (npmCandidates.length > 0) {
    const { healthy } = await verifyNpmSpecs(npmCandidates, executionEnv);
    for (const pkg of npmCandidates) {
      if (healthy.has(pkg)) {
        result.ready.push(pkg);
        provisionedThisRun.add(`npm:${pkg}`);
      } else {
        npmPkgs.push(pkg);
      }
    }
  }

  // Resolve the interpreter and its identity-keyed overlay once. Everything pip
  // touches — the presence probe, the install, and the post-install
  // verification — must run against this same environment, otherwise readiness
  // and execution can disagree (Issue #702 root cause 4).
  const pythonEnv = pipCandidates.length > 0 ? await resolveManagedPythonEnv() : null;
  if (pipCandidates.length > 0 && !pythonEnv) {
    // Fail closed with a specific reason rather than installing somewhere
    // unkeyed and hoping the packages match whatever python later runs.
    for (const pkg of pipCandidates) {
      result.failed.push({ package: pkg, error: 'no managed python interpreter could be resolved or fingerprinted' });
    }
    logger.error('pip provisioning skipped: no managed python interpreter available');
  }

  const pipPkgs: string[] = [];
  if (pythonEnv) {
    // Cache keys carry the environment identity: "provisioned" is only ever true
    // *for a given interpreter*. A bare `pip:<pkg>` key would wrongly report a
    // package ready after the resolved interpreter changed underneath it.
    const cacheKey = (pkg: string) => `pip:${pythonEnv.envId}:${pkg}`;
    const uncached = pipCandidates.filter((pkg) => {
      if (!provisionedThisRun.has(cacheKey(pkg))) return true;
      result.ready.push(pkg);
      return false;
    });
    const { healthy } = await verifyPipSpecs(pythonEnv, uncached);
    for (const pkg of uncached) {
      if (healthy.has(pkg)) {
        result.ready.push(pkg);
        provisionedThisRun.add(cacheKey(pkg));
      } else {
        // Present-but-broken (e.g. wrong architecture) also lands here, so a
        // reinstall into the correct identity-keyed overlay is attempted.
        pipPkgs.push(pkg);
      }
    }
  }

  if (npmPkgs.length === 0 && pipPkgs.length === 0) return result;

  // Chain onto any in-flight install so writers to the shared prefix serialize.
  const work = installChain.then(async () => {
    ensureRuntimeDir(pythonEnv?.envDir);
    const stamp = new Date().toISOString();

    if (npmPkgs.length > 0) {
      logger.info({ packages: npmPkgs }, 'provisioning skill npm dependencies');
      const { ok, output } = await run('npm', [
        'install', '--prefix', getSkillRuntimeDir(),
        '--no-save', '--no-audit', '--no-fund', '--loglevel=error',
        ...npmPkgs,
      ], executionEnv);
      if (ok) {
        const { healthy, broken } = await verifyNpmSpecs(npmPkgs, executionEnv);
        for (const pkg of npmPkgs) {
          if (healthy.has(pkg)) {
            result.installed.push(pkg);
            provisionedThisRun.add(`npm:${pkg}`);
          } else {
            result.failed.push({ package: pkg, error: broken.get(pkg) ?? 'installed but failed module resolution' });
          }
        }
      } else {
        for (const pkg of npmPkgs) result.failed.push({ package: pkg, error: output });
      }
      if (!ok) logger.warn({ packages: npmPkgs, output }, 'npm provisioning failed');
    }

    if (pipPkgs.length > 0 && pythonEnv) {
      logger.info(
        { packages: pipPkgs, envId: pythonEnv.envId, interpreter: pythonEnv.interpreter },
        'provisioning skill pip dependencies',
      );
      const { ok, output } = await run(pythonEnv.interpreter, [
        '-m', 'pip', 'install', '--target', pythonEnv.envDir,
        '--disable-pip-version-check', '--no-input', '--quiet',
        // Never build from source: a source build resolves against whatever
        // toolchain the host happens to have and is the slow path that made the
        // model give up and start probing. Mirrors the build-time contract.
        '--only-binary=:all:',
        '--index-url', managedPipIndexUrl(),
        ...pipPkgs,
      ], buildManagedPipEnv(pythonEnv.envDir, process.env, pythonEnv.interpreter));
      if (!ok) {
        for (const pkg of pipPkgs) result.failed.push({ package: pkg, error: output });
        logger.warn({ packages: pipPkgs, output }, 'pip provisioning failed');
      } else {
        // pip exiting 0 is not proof the packages load. Verify by import before
        // recording anything as provisioned — a partial or architecture-mismatched
        // install must never be reported ready.
        const { healthy, broken } = await verifyPipSpecs(pythonEnv, pipPkgs);
        for (const pkg of pipPkgs) {
          if (healthy.has(pkg)) {
            result.installed.push(pkg);
            provisionedThisRun.add(`pip:${pythonEnv.envId}:${pkg}`);
          } else {
            result.failed.push({ package: pkg, error: broken.get(pkg) ?? 'installed but failed import verification' });
          }
        }
        if (broken.size > 0) {
          logger.warn({ broken: Object.fromEntries(broken), envId: pythonEnv.envId }, 'pip packages installed but failed import verification');
        }
      }
    }

    if (pythonEnv) {
      // Record only verified specs, keyed to this environment's identity. This
      // manifest is read on the next activation (unlike the old
      // `.provisioned.json`, which nothing ever consulted).
      const manifest = readEnvManifest(pythonEnv);
      for (const pkg of result.installed) {
        if (pipPkgs.includes(pkg)) manifest.installed[pkg] = stamp;
      }
      writeEnvManifest(pythonEnv, manifest);
    }
  });

  // Keep the chain alive even if this batch throws, so later calls still run.
  installChain = work.catch(() => undefined);
  await work.catch((err) => {
    logger.warn({ err: String(err) }, 'skill dependency provisioning errored');
  });
  return result;
}
