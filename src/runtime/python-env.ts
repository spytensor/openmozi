/**
 * Managed Python environment identity and resolution.
 *
 * Single source of truth for *which* interpreter MOZI runs and *which* package
 * overlay is legal for it. Both the provisioner (skills/provision-deps.ts) and
 * the executor (capabilities/shell.ts) resolve through here, so readiness and
 * execution can never test different environments.
 *
 * Why this module exists
 * ----------------------
 * The previous design installed skill pip dependencies into one flat
 * `<moziHome>/skill-runtime/python` directory and unconditionally prepended it
 * to PYTHONPATH for every shell command. That directory has no notion of which
 * interpreter produced it, so a tree built by an x86_64 host python (e.g. a
 * Homebrew/Miniconda `python3` picked up from PATH) would shadow the packages
 * of the bundled arm64 interpreter. Both are CPython 3.11, so the `cp311` ABI
 * tag matches and the shadowing is accepted as valid — the failure only
 * surfaces at `dlopen`:
 *
 *     incompatible architecture (have 'x86_64', need 'arm64')
 *
 * A version-keyed cache does not catch this; only architecture does.
 *
 * The fix is structural rather than procedural: the overlay directory is keyed
 * by the interpreter's own ABI/platform/architecture fingerprint
 * (`cp311-macosx-arm64`). A tree built by an x86_64 interpreter lands in
 * `cp311-macosx-x86_64` and is therefore never on the arm64 interpreter's path.
 * There is no rule to enforce and nothing to get wrong at a call site — the
 * incompatible tree is simply not reachable. Mixed-architecture hosts (an App
 * bundle plus a Rosetta Miniconda) keep separate, individually-valid overlays.
 *
 * Identity vs. lock hash
 * ----------------------
 * Issue #702 asks that a managed environment be keyed by python version,
 * ABI, platform, architecture *and* dependency lock hash. The first four are
 * folded into `envId` here. The lock hash deliberately is not: this overlay is
 * incremental (skills declare `install:` specs ad hoc and are activated at
 * arbitrary times), so folding a lock hash into the directory name would mint a
 * fresh environment and re-download every package each time any skill adds a
 * dependency. Instead each environment carries a manifest (`.mozi-env.json`)
 * recording its fingerprint and the exact specs that verifiably imported. It is
 * evidence, surfaced by the capability snapshot — never a decision input, since
 * trusting a recorded claim over a live import is what this module exists to
 * stop. That preserves auditability without churning identity. The immutable
 * *bundled* runtime is a different case — it has a real lock, and
 * `stage-desktop-python.mjs` already fingerprints it with `requirements_sha256`
 * in `MOZI_RUNTIME.json`.
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { constants, accessSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import { getSkillRuntimeDir } from '../paths.js';

const logger = pino({ name: 'mozi:runtime:python-env' });

/**
 * Promisified lazily rather than at module load: this module sits in the import
 * graph of the shell/TEL stack, and touching the `execFile` binding at import
 * time breaks callers that mock `node:child_process` with a partial surface.
 */
function execFileAsync(
  file: string,
  args: string[],
  options: Parameters<typeof execFile>[2],
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(file, args, options) as Promise<{ stdout: string; stderr: string }>;
}

/** Successful interpreter probes only — see probePythonFingerprint on why failures are not cached. */
const fingerprintCache = new Map<string, PythonFingerprint>();

const PROBE_TIMEOUT_MS = 10_000;

/** Identity of a Python interpreter, at the granularity that governs native ABI compatibility. */
export interface PythonFingerprint {
  /** Full version, e.g. "3.11.15". Recorded for evidence; not part of envId. */
  python_version: string;
  /** e.g. "cpython", "pypy". */
  implementation: string;
  /** Wheel ABI tag, e.g. "cp311". Patch releases share an ABI, so this is the right grain. */
  abi_tag: string;
  /** e.g. "macosx", "linux". */
  platform: string;
  /** e.g. "arm64", "x86_64". The axis the old flat layout ignored. */
  arch: string;
}

/** A resolved, identity-keyed Python environment. */
export interface ManagedPythonEnv {
  /** Absolute path to the interpreter this environment belongs to. */
  interpreter: string;
  fingerprint: PythonFingerprint;
  /** Directory-safe identity, e.g. "cp311-macosx-arm64". */
  envId: string;
  /** pip `--target` root for this identity. May not exist yet. */
  envDir: string;
}

/**
 * Per-environment manifest, written next to the packages it describes.
 *
 * Read by `buildDesktopCapabilitySnapshot` to report what a runtime actually
 * provides. Deliberately not consulted when deciding whether to install: that
 * decision is made by importing the packages.
 */
export interface ManagedPythonEnvManifest {
  env_id: string;
  fingerprint: PythonFingerprint;
  interpreter: string;
  /** Spec string -> ISO timestamp of last successful *verified* install. */
  installed: Record<string, string>;
  updated_at: string;
}

/** Container for all per-identity environments. Never itself a `--target`. */
export function getSkillPythonRoot(): string {
  return join(getSkillRuntimeDir(), 'python');
}

function isExecutable(candidate: string): boolean {
  try {
    // X_OK alone succeeds on directories (it means "searchable" for them), so a
    // PATH entry containing a `python3` directory would resolve as an interpreter.
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(command: string, pathValue: string): string | null {
  if (isAbsolute(command)) return isExecutable(command) ? command : null;
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(entry, command);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the interpreter MOZI manages, in strict priority order:
 *   1. `MOZI_PYTHON` — set by the desktop supervisor to the bundled interpreter.
 *   2. `PYTHON` — explicit operator override.
 *   3. `python3` on PATH.
 *
 * Returning the *same* interpreter to both the provisioner and the executor is
 * what keeps the overlay identity honest: the tree we inject is always keyed to
 * the fingerprint of the interpreter that `python3` actually resolves to in the
 * same environment. Under the packaged App the supervisor puts the bundled
 * interpreter first on PATH, so all three tiers agree.
 */
export function resolveManagedPythonInterpreter(env: NodeJS.ProcessEnv = process.env): string | null {
  const pathValue = env.PATH ?? '';
  for (const candidate of [env.MOZI_PYTHON, env.PYTHON, 'python3']) {
    if (!candidate) continue;
    const resolved = resolveOnPath(candidate, pathValue);
    if (resolved) return resolved;
  }
  return null;
}

const FINGERPRINT_SCRIPT = [
  'import json, platform, sys, sysconfig',
  'impl = sys.implementation.name',
  "prefix = 'cp' if impl == 'cpython' else impl",
  'print(json.dumps({',
  '  "python_version": ".".join(str(p) for p in sys.version_info[:3]),',
  '  "implementation": impl,',
  '  "abi_tag": "%s%d%d" % (prefix, sys.version_info[0], sys.version_info[1]),',
  '  "platform": sysconfig.get_platform().split("-")[0],',
  '  "arch": platform.machine(),',
  '}))',
].join('\n');

function sanitizeIdComponent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

/** Directory-safe identity. Mirrors wheel tag conventions: `cp311-macosx-arm64`. */
export function computeEnvId(fingerprint: PythonFingerprint): string {
  return [fingerprint.abi_tag, fingerprint.platform, fingerprint.arch].map(sanitizeIdComponent).join('-');
}

/**
 * Ask an interpreter to describe itself. Returns null if it cannot be probed —
 * callers must fail closed rather than guessing an identity.
 */
export async function probePythonFingerprint(interpreter: string): Promise<PythonFingerprint | null> {
  const cached = fingerprintCache.get(interpreter);
  if (cached) return cached;

  let fingerprint: PythonFingerprint | null = null;
  try {
    // `-I` isolates the interpreter, so an inherited PYTHONPATH/PYTHONHOME cannot
    // colour the probe. The env is otherwise passed through: wiping it would drop
    // LD_LIBRARY_PATH, which some interpreters need to find libpython — turning a
    // working interpreter into a permanent failure.
    const { stdout } = await execFileAsync(interpreter, ['-I', '-c', FINGERPRINT_SCRIPT], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      env: { ...process.env, PYTHONNOUSERSITE: '1' },
    });
    const parsed = JSON.parse(stdout) as PythonFingerprint;
    // Every component is required: a partial response would reach computeEnvId
    // and throw out of the caller, which must never happen for provisioning.
    const complete = parsed
      && typeof parsed.abi_tag === 'string'
      && typeof parsed.arch === 'string'
      && typeof parsed.platform === 'string'
      && typeof parsed.implementation === 'string'
      && typeof parsed.python_version === 'string';
    if (complete) fingerprint = parsed;
    else logger.warn({ interpreter, stdout: stdout.slice(0, 200) }, 'incomplete python fingerprint');
  } catch (err) {
    logger.warn({ interpreter, err: String(err) }, 'could not fingerprint python interpreter');
  }
  // Only successes are cached. A failure may be transient (a timeout under load,
  // EAGAIN), and caching it would disable python for the rest of the process —
  // nothing in production invalidates this cache.
  //
  // The cost is that a genuinely broken interpreter is re-probed by each shell
  // command (measured: ~47ms on top of an ~8ms command). That is an acceptable
  // trade: it only applies to a misconfigured host, it is bounded and visible,
  // and the alternative silently loses python capability for the whole session.
  // The healthy path — the normal one — probes once per process.
  if (fingerprint) fingerprintCache.set(interpreter, fingerprint);
  return fingerprint;
}

/** Drop cached interpreter probes (config reload / tests). */
export function resetPythonEnvCache(): void {
  fingerprintCache.clear();
}

/**
 * Resolve the managed interpreter and its identity-keyed overlay directory.
 * Returns null when no interpreter can be resolved or fingerprinted — callers
 * must then report the capability unavailable with a specific reason rather
 * than falling back to an unkeyed directory.
 */
export async function resolveManagedPythonEnv(env: NodeJS.ProcessEnv = process.env): Promise<ManagedPythonEnv | null> {
  const interpreter = resolveManagedPythonInterpreter(env);
  if (!interpreter) return null;
  const fingerprint = await probePythonFingerprint(interpreter);
  if (!fingerprint) return null;
  const envId = computeEnvId(fingerprint);
  return { interpreter, fingerprint, envId, envDir: join(getSkillPythonRoot(), envId) };
}

/**
 * Build the environment for managed Python execution.
 *
 * Clears inherited PYTHONPATH / PYTHONHOME / VIRTUAL_ENV so a host virtualenv
 * or conda shell cannot inject packages of a different architecture, then sets
 * PYTHONPATH to exactly the overlay whose identity matches `envDir`'s
 * interpreter. Passing `envDir: null` yields a clean, overlay-free environment
 * (used when no verified overlay exists).
 */
export function applyManagedPythonEnv<T extends Record<string, string>>(
  base: T,
  envDir: string | null,
  interpreter?: string | null,
): T {
  const next: Record<string, string> = { ...base };
  delete next.PYTHONHOME;
  delete next.VIRTUAL_ENV;
  // Never inherit an outside PYTHONPATH: it is the exact vector that let an
  // x86_64 tree onto an arm64 interpreter's import path.
  if (envDir) next.PYTHONPATH = envDir;
  else delete next.PYTHONPATH;
  next.PYTHONNOUSERSITE = '1';
  // Put the managed interpreter first on PATH so a bare `python3` in a command
  // *is* the interpreter the overlay was built for.
  //
  // Without this the overlay's identity is only half-enforced: PYTHONPATH is
  // keyed to the resolved interpreter, but `python3` resolves independently
  // through PATH. Set MOZI_PYTHON without also leading PATH with it — which is
  // every non-packaged run — and a command gets an arm64 overlay on an x86_64
  // interpreter, reproducing the exact dlopen failure this module exists to
  // remove, from the other direction. Verified: PYTHONPATH pointed at
  // `cp311-macosx-arm64` while `which python3` was a Rosetta Miniconda.
  //
  // The packaged App happened to be safe because its supervisor already leads
  // PATH with the bundled interpreter. That made the invariant true by luck;
  // this makes it true by construction.
  // Reorder only when PATH would otherwise resolve a *different* interpreter.
  //
  // This holds the invariant for any interpreter whose directory exposes a
  // `python3` — every real configuration. An operator pointing PYTHON at a bare
  // `python3.11` in a directory with no `python3` sibling is not covered:
  // hoisting that directory cannot change what `python3` resolves to. That
  // degrades to an import error rather than a silent architecture crash.
  // When `python3` already resolves to the managed one — the packaged App, and
  // any run where it was found on PATH in the first place — PATH is already
  // consistent and is left exactly as the operator has it. This matters because
  // the interpreter's directory carries a whole python toolchain (pip, f2py,
  // markitdown, pdfplumber...), and hoisting it unnecessarily would shadow the
  // user's own copies of those for every shell command.
  if (interpreter && resolveOnPath('python3', next.PATH ?? '') !== interpreter) {
    const binDir = dirname(interpreter);
    const entries = (next.PATH ?? '').split(delimiter).filter(Boolean);
    next.PATH = [binDir, ...entries.filter((entry) => entry !== binDir)].join(delimiter);
  }
  return next as T;
}

/**
 * pip environment for provisioning.
 *
 * `stage-desktop-python.mjs` already hardens the *build*-time install this way;
 * the runtime path did not, which is why host pip configuration (a mirror in
 * `~/.pip/pip.conf`) and source builds could produce a tree that did not match
 * the interpreter. This lifts the same contract onto the runtime path.
 */
export function buildManagedPipEnv(
  envDir: string | null,
  base: NodeJS.ProcessEnv = process.env,
  interpreter?: string | null,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    // Host pip configuration (index mirrors, build flags) must not leak in.
    if (value === undefined || key.startsWith('PIP_')) continue;
    clean[key] = value;
  }
  clean.PIP_CONFIG_FILE = '/dev/null';
  return applyManagedPythonEnv(clean, envDir, interpreter);
}

/** Index pip installs from. Defaults to PyPI; operators on restricted networks may override. */
export function managedPipIndexUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.MOZI_PIP_INDEX_URL || 'https://pypi.org/simple';
}

// ---------------------------------------------------------------------------
// Per-environment manifest
// ---------------------------------------------------------------------------

function manifestPath(envDir: string): string {
  return join(envDir, '.mozi-env.json');
}

export function readEnvManifest(env: ManagedPythonEnv): ManagedPythonEnvManifest {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(env.envDir), 'utf8')) as ManagedPythonEnvManifest;
    // A manifest whose identity disagrees with its own directory is not
    // trustworthy — treat it as empty rather than honouring stale claims.
    if (parsed?.env_id === env.envId && parsed.installed && typeof parsed.installed === 'object') return parsed;
  } catch {
    // Missing or unreadable: start from empty.
  }
  return { env_id: env.envId, fingerprint: env.fingerprint, interpreter: env.interpreter, installed: {}, updated_at: '' };
}

export function writeEnvManifest(env: ManagedPythonEnv, manifest: ManagedPythonEnvManifest): void {
  try {
    mkdirSync(env.envDir, { recursive: true });
    writeFileSync(manifestPath(env.envDir), JSON.stringify({ ...manifest, updated_at: new Date().toISOString() }, null, 2), 'utf8');
  } catch (err) {
    logger.warn({ envDir: env.envDir, err: String(err) }, 'failed to persist managed python env manifest');
  }
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

/**
 * A `pip install --target` always writes `*.dist-info` beside the packages, so
 * a dist-info directly under the root is a definitive marker of the old flat
 * (unkeyed) layout. Identity-keyed environments only ever place `<envId>/`
 * directories at the root.
 */
function hasLegacyFlatLayout(root: string): boolean {
  try {
    return readdirSync(root).some((entry) => entry.endsWith('.dist-info'));
  } catch {
    return false;
  }
}

export interface LegacyQuarantineResult {
  quarantined: boolean;
  /** Where the old tree was moved. Never deleted. */
  movedTo?: string;
}

/**
 * Quarantine an unkeyed `skill-runtime/python` tree left by an older install.
 *
 * These trees are the ones that can carry foreign-architecture packages, and
 * they survive App upgrades because they live in the data home rather than the
 * bundle. They are *renamed*, never deleted: the contents may include packages
 * the operator installed deliberately, and Issue #702 forbids destructive
 * cleanup of the real data home. A fresh identity-keyed environment is built
 * alongside on next provision.
 */
export function quarantineLegacyPythonRuntime(now: () => Date = () => new Date()): LegacyQuarantineResult {
  const root = getSkillPythonRoot();
  if (!existsSync(root) || !hasLegacyFlatLayout(root)) return { quarantined: false };
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const movedTo = `${root}.quarantine-${stamp}`;
  try {
    renameSync(root, movedTo);
    mkdirSync(root, { recursive: true });
    logger.warn(
      { movedTo },
      'quarantined legacy unkeyed skill-runtime python tree; it could shadow the managed interpreter with foreign-architecture packages',
    );
    return { quarantined: true, movedTo };
  } catch (err) {
    logger.error({ root, err: String(err) }, 'failed to quarantine legacy skill-runtime python tree');
    return { quarantined: false };
  }
}
