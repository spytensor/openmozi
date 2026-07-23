#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_PYTHON_VERSION = '3.11.15';
const DEFAULT_RELEASE = '20260510';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_DEST = join(ROOT, 'desktop', 'resources', 'python');
const DEFAULT_REQUIREMENTS = join(ROOT, 'requirements', 'document-runtime.txt');
const DEFAULT_CONSTRAINTS = join(ROOT, 'requirements', 'document-runtime-constraints.txt');
const PYTHON_IMPORT_CHECK = 'import defusedxml, docx, imageio, numpy, openpyxl, pandas, pdf2image, pdfplumber, PIL, pptx, pypdf, reportlab, markitdown';

const KNOWN_SHA256 = {
  'cpython-3.11.15+20260510-aarch64-apple-darwin-install_only_stripped.tar.gz': 'fdfc363b538662eb7441a14e06f72c4a992c56af7f401f5730ea5081f8f8ad6e',
  'cpython-3.11.15+20260510-x86_64-apple-darwin-install_only_stripped.tar.gz': '5f1eb247cbca2c0ad5ccbf6d299a4f54b31b5c63b492d74c3531dc4344a42f88',
};

function getArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return fallback;
}

function normalizeArch(raw) {
  if (raw === 'arm64' || raw === 'aarch64') return 'aarch64';
  if (raw === 'x64' || raw === 'x86_64') return 'x86_64';
  throw new Error(`Unsupported desktop Python architecture: ${raw}`);
}

export function pythonAssetFor(version, release, arch) {
  const targetArch = normalizeArch(arch);
  const fileName = `cpython-${version}+${release}-${targetArch}-apple-darwin-install_only_stripped.tar.gz`;
  const sha256 = KNOWN_SHA256[fileName];
  if (!sha256) {
    throw new Error(`No pinned SHA256 for desktop Python asset ${fileName}`);
  }
  return {
    fileName,
    sha256,
    url: `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/${encodeURIComponent(`cpython-${version}+${release}-${targetArch}-apple-darwin-install_only_stripped.tar.gz`)}`,
  };
}

export function copyStandalonePython(source, destination) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, verbatimSymlinks: true });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Mark the staged interpreter as externally managed (PEP 668).
 *
 * The packaged runtime is a build artifact with a pinned, verified dependency
 * set — it is not a scratch environment. Without this marker nothing stops a
 * model from running `python3 -m pip install <anything>` through shell_exec:
 * because the supervisor puts this interpreter first on PATH and pip defaults to
 * its own site-packages, the packages land inside the signed .app. That has
 * happened in the field (fpdf2, fonttools and matplotlib were all found inside
 * an installed MOZI.app, none of them in requirements/document-runtime.txt),
 * which both invalidates the code signature and makes a developer's machine
 * disagree with a clean install about what the runtime provides.
 *
 * PEP 668 is the standard, pip-enforced way to express this, so pip itself
 * refuses the install with a clear message instead of MOZI trying to pattern-match
 * dangerous shell commands. Skill dependencies are unaffected: they install into
 * an identity-keyed overlay via `pip install --target`, which PEP 668 permits by
 * design.
 *
 * Written *after* the build-time install, which must still be allowed to run.
 */
function markRuntimeExternallyManaged(pythonBin, dest) {
  const stdlib = execFileSync(pythonBin, ['-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', PYTHONNOUSERSITE: '1' },
  }).trim();
  if (!stdlib || !existsSync(stdlib)) {
    throw new Error(`Could not resolve stdlib path for ${pythonBin}; refusing to ship a mutable runtime`);
  }
  const marker = join(stdlib, 'EXTERNALLY-MANAGED');
  writeFileSync(marker, [
    '[externally-managed]',
    'Error=This interpreter is part of the MOZI application bundle and is managed by MOZI.',
    ' Installing packages into it would modify the signed application and would be lost on upgrade.',
    ' Skill dependencies are installed into a managed, architecture-keyed overlay instead:',
    ' declare them in a skill\'s `install:` manifest, or use `pip install --target <dir>`.',
    '',
  ].join('\n'), 'utf8');
  console.log(`Marked runtime externally managed (PEP 668): ${marker.slice(dest.length + 1)}`);
}

async function downloadFile(url, destination) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

export async function main() {
  const version = getArg('--version', process.env.MOZI_DESKTOP_PYTHON_VERSION || DEFAULT_PYTHON_VERSION);
  const release = getArg('--release', process.env.MOZI_DESKTOP_PYTHON_RELEASE || DEFAULT_RELEASE);
  const arch = getArg('--arch', process.env.MOZI_DESKTOP_PYTHON_ARCH || process.env.MOZI_DESKTOP_NODE_ARCH || process.arch);
  const dest = resolve(getArg('--dest', process.env.MOZI_DESKTOP_PYTHON_DEST || DEFAULT_DEST));
  const requirements = resolve(getArg('--requirements', DEFAULT_REQUIREMENTS));
  const constraints = resolve(getArg('--constraints', DEFAULT_CONSTRAINTS));
  const asset = pythonAssetFor(version, release, arch);
  const tempDir = await mkdtemp(join(tmpdir(), 'mozi-desktop-python-'));
  const archive = join(tempDir, asset.fileName);

  if (!existsSync(requirements)) throw new Error(`Document runtime requirements missing at ${requirements}`);
  if (!existsSync(constraints)) throw new Error(`Document runtime constraints missing at ${constraints}`);
  console.log(`Staging managed Python ${version} (${normalizeArch(arch)}-apple-darwin) for MOZI Desktop`);
  console.log(`Destination: ${dest}`);

  try {
    await downloadFile(asset.url, archive);
    const actual = sha256(archive);
    if (actual !== asset.sha256) {
      throw new Error(`SHA256 mismatch for ${asset.fileName}: expected ${asset.sha256}, got ${actual}`);
    }

    execFileSync('tar', ['-xzf', archive, '-C', tempDir], { stdio: 'inherit' });
    const extracted = join(tempDir, 'python');
    if (!existsSync(join(extracted, 'bin', 'python3'))) {
      throw new Error(`Standalone Python archive did not contain python/bin/python3`);
    }

    copyStandalonePython(extracted, dest);

    const pythonBin = join(dest, 'bin', 'python3');
    const cleanPipEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PIP_')));
    const pythonEnv = { ...cleanPipEnv, PIP_CONFIG_FILE: '/dev/null', PYTHONNOUSERSITE: '1' };
    execFileSync(pythonBin, [
      '-m', 'pip', 'install',
      '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--no-warn-script-location',
      '--only-binary=:all:', '--index-url', 'https://pypi.org/simple',
      '--requirement', requirements,
      '--constraint', constraints,
    ], { stdio: 'inherit', env: pythonEnv });
    execFileSync(pythonBin, ['-m', 'pip', 'check'], { stdio: 'inherit', env: pythonEnv });
    execFileSync(pythonBin, ['-c', PYTHON_IMPORT_CHECK], { stdio: 'inherit', env: pythonEnv });

    markRuntimeExternallyManaged(pythonBin, dest);

    writeFileSync(join(dest, 'MOZI_RUNTIME.json'), JSON.stringify({
      python_version: version,
      standalone_release: release,
      target_arch: normalizeArch(arch),
      source_asset: asset.fileName,
      source_sha256: asset.sha256,
      requirements_sha256: sha256(requirements),
      constraints_sha256: sha256(constraints),
    }, null, 2));
    console.log(`Managed document runtime ready at ${pythonBin}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
