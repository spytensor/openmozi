#!/usr/bin/env node
/**
 * Config-driven one-way export of this tree into the public
 * OpenMozi repository.
 *
 * What participates in the export is declared in
 * `scripts/public-export.config.json` — this script only executes that policy:
 *
 *   1. Materializes the tracked tree at `--ref` (default HEAD) via `git
 *      archive`, so untracked or dirty files can never leak.
 *   2. Drops every path matched by `exclude` (exact path, or directory prefix
 *      when the entry ends with `/`).
 *   3. Mirrors the result into the target working tree: stale tracked files
 *      are deleted, `preserveTarget` paths are never touched, and
 *      `preserveTargetVersion` files keep the target repository's own
 *      `"version"` field (the public repo owns its version line).
 *   4. Stages everything and runs the exported
 *      `scripts/verify-public-export.mjs` privacy gate inside the target.
 *      A violation fails the export (and blocks `--commit`).
 *
 * Usage:
 *   node scripts/export-public.mjs --target ../openmozi [--ref HEAD]
 *                                  [--dry-run] [--commit] [--config <path>]
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Returns true when `path` is excluded by the configured patterns. */
export function isExcluded(path, excludePatterns) {
  return excludePatterns.some((pattern) =>
    pattern.endsWith('/') ? path.startsWith(pattern) : path === pattern,
  );
}

/**
 * Returns true when a file's *content* marks it as private, regardless of path.
 *
 * Path lists cannot express "anything a local tool generates": editor and
 * assistant plugins write per-directory scratch files, and a new directory
 * grows a new one that no exclude list anticipated. 43 such files — carrying
 * session ids and session titles from the operator's own machine — reached the
 * public repository this way before this check existed.
 */
export function hasPrivateMarker(contentText, markers) {
  return markers.some((marker) => contentText.includes(marker));
}

/**
 * Rewrites the first `"version"` field in a package.json source text to the
 * target repository's own version. Returns the source text unchanged when the
 * target version is unknown (first export).
 */
export function withTargetVersion(sourceText, targetVersion) {
  if (!targetVersion) return sourceText;
  return sourceText.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${targetVersion}"`);
}

/** The public tree's own version, used for the public-facing commit message. */
function readTargetVersion(target) {
  try {
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    return typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', ...opts });
}

function parseArgs(argv) {
  const args = { ref: 'HEAD', dryRun: false, commit: false, target: null, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--target') args.target = argv[++i];
    else if (arg === '--ref') args.ref = argv[++i];
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--commit') args.commit = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function removeEmptyDirs(dir, stopAt) {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    try {
      if (readdirSync(current).length > 0) return;
      rmdirSync(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // Source repo = the repo the command is run from, so tests can drive fixtures.
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();

  const configPath = args.config ? resolve(args.config) : join(repoRoot, 'scripts/public-export.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const exclude = config.exclude ?? [];
  const excludeContaining = config.excludeContaining ?? [];
  const preserveTarget = new Set(config.preserveTarget ?? []);
  const preserveVersion = new Set(config.preserveTargetVersion ?? []);
  for (const entry of [...preserveTarget, ...preserveVersion]) {
    if (entry.endsWith('/')) {
      throw new Error(`preserve entries must be exact file paths (directory prefixes are only supported in exclude): ${entry}`);
    }
  }

  if (!args.target) throw new Error('missing --target <path to public repo working tree>');
  const target = resolve(args.target);
  if (!existsSync(join(target, '.git'))) throw new Error(`target is not a git repository: ${target}`);
  if (target === repoRoot || target.startsWith(repoRoot + sep)) {
    throw new Error('target must live outside the source repository');
  }
  if (git(target, ['status', '--porcelain']).trim() !== '') {
    throw new Error(`target working tree is not clean: ${target}`);
  }

  const refSha = git(repoRoot, ['rev-parse', args.ref]).trim();
  const sourceVersion = JSON.parse(git(repoRoot, ['show', `${refSha}:package.json`])).version;

  // 1. Materialize the tracked tree at the ref — never the working tree.
  const stage = mkdtempSync(join(tmpdir(), 'mozi-public-export-'));
  try {
    const tarPath = join(stage, 'export.tar');
    execFileSync('git', ['archive', '--format=tar', '-o', tarPath, refSha], { cwd: repoRoot });
    const treeDir = join(stage, 'tree');
    mkdirSync(treeDir);
    execFileSync('tar', ['-xf', tarPath, '-C', treeDir]);

    const sourceFiles = git(repoRoot, ['ls-tree', '-r', '--name-only', '-z', refSha])
      .split('\0')
      .filter(Boolean);
    const exported = sourceFiles.filter((path) => {
      if (isExcluded(path, exclude)) return false;
      if (excludeContaining.length === 0) return true;
      const abs = join(treeDir, path);
      // Binary files cannot carry a text marker; reading them as utf8 is wasteful
      // but harmless, and skipping unreadable entries keeps this from being able
      // to fail the export.
      let text;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        return true;
      }
      return !hasPrivateMarker(text, excludeContaining);
    });
    const exportedSet = new Set(exported);
    const excludedCount = sourceFiles.length - exported.length;

    const targetTracked = git(target, ['ls-files', '-z']).split('\0').filter(Boolean);
    const removals = targetTracked.filter(
      (path) => !exportedSet.has(path) && !preserveTarget.has(path),
    );

    let added = 0;
    let updated = 0;
    if (args.dryRun) {
      for (const path of removals) console.log(`would remove: ${path}`);
      for (const path of exported) {
        if (preserveTarget.has(path)) continue;
        if (!existsSync(join(target, path))) console.log(`would add: ${path}`);
      }
      console.log(
        `[export-public] dry-run: ${exported.length} files from ${args.ref} (${refSha.slice(0, 8)}), ` +
          `${excludedCount} excluded, ${removals.length} removals, target untouched`,
      );
      return;
    }

    for (const path of removals) {
      const abs = join(target, path);
      if (existsSync(abs)) {
        unlinkSync(abs);
        removeEmptyDirs(dirname(abs), target);
      }
    }

    for (const path of exported) {
      if (preserveTarget.has(path)) continue;
      const src = join(treeDir, path);
      const dest = join(target, path);
      const existed = existsSync(dest);
      mkdirSync(dirname(dest), { recursive: true });
      if (preserveVersion.has(path)) {
        let targetVersion = null;
        if (existed) {
          try {
            targetVersion = JSON.parse(readFileSync(dest, 'utf8')).version ?? null;
          } catch {
            targetVersion = null;
          }
        }
        writeFileSync(dest, withTargetVersion(readFileSync(src, 'utf8'), targetVersion));
      } else {
        copyFileSync(src, dest);
      }
      if (existed) updated += 1;
      else added += 1;
    }

    // 2. Stage and run the exported privacy gate inside the target.
    git(target, ['add', '-A']);
    try {
      execFileSync('node', ['scripts/verify-public-export.mjs'], {
        cwd: target,
        stdio: 'inherit',
      });
    } catch {
      // `return` (not process.exit) so the finally block still removes the
      // staged private tree from tmpdir.
      console.error('[export-public] privacy gate FAILED — target left staged for inspection, no commit made');
      process.exitCode = 1;
      return;
    }

    const staged = git(target, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
    console.log(
      `[export-public] synced ${exported.length} files from ${args.ref} (${refSha.slice(0, 8)}, internal v${sourceVersion}); ` +
        `${excludedCount} excluded, ${added} added, ${updated} overwritten, ${removals.length} removed, ${staged.length} staged changes`,
    );

    if (args.commit) {
      if (staged.length === 0) {
        console.log('[export-public] nothing to commit — target already up to date');
        return;
      }
      // The message lands in a PUBLIC repository: it must never carry the
      // internal project name, internal version, or an internal commit sha.
      // The public tree owns its own version line; that is the only version
      // that means anything to a reader of that repository.
      const targetVersion = readTargetVersion(target);
      git(target, ['commit', '-m', targetVersion
        ? `sync: update public tree for v${targetVersion}`
        : 'sync: update public tree']);
      console.log(`[export-public] committed in ${target}`);
    } else if (staged.length > 0) {
      console.log('[export-public] changes staged in target — review with `git -C <target> status`, then commit');
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
