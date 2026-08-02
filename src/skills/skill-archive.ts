/**
 * Skill packages travel as archives, not as directories.
 *
 * `skills/skill-creator/scripts/package_skill.py` — bundled in this very repo —
 * emits a `.skill` file, which is a zip. Anthropic's own distribution channel
 * and every "here is a skill I made" hand-off arrive the same way, often as a
 * zip *containing* the `.skill` plus loose sample files. `install_skill` used to
 * accept only a directory holding `SKILL.md`, so the runtime could not install
 * the format its own tooling produces.
 *
 * This module unpacks such an archive to a temp directory and locates the
 * `SKILL.md` inside it, including one level of nested `.skill`/zip.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

/** Archive extensions accepted as a skill package source. */
export const SKILL_ARCHIVE_EXTENSIONS = ['.skill', '.zip', '.tar.gz', '.tgz', '.tar'] as const;

/** Entries that are packaging noise, never part of the skill itself. */
const IGNORED_ENTRIES = new Set(['__MACOSX', '.DS_Store']);

/** Guard against a pathological nesting chain rather than recursing forever. */
const MAX_LOCATE_DEPTH = 4;

const EXTRACT_TIMEOUT_MS = 60_000;

export interface ExtractedSkillArchive {
  /** Absolute path to the located `SKILL.md`. */
  skillFilePath: string;
  /** Temp directories created during extraction; the caller must remove them. */
  tempDirs: string[];
}

function lowerName(path: string): string {
  return basename(path).toLowerCase();
}

/** True when the path *looks like* a skill archive, by extension alone. */
export function isSkillArchivePath(path: string): boolean {
  const name = lowerName(path);
  return SKILL_ARCHIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function archiveKind(path: string): 'zip' | 'tar' {
  const name = lowerName(path);
  if (name.endsWith('.tar.gz') || name.endsWith('.tgz') || name.endsWith('.tar')) return 'tar';
  return 'zip';
}

function runExtractor(command: string, args: string[]): void {
  execFileSync(command, args, { stdio: 'pipe', timeout: EXTRACT_TIMEOUT_MS });
}

/**
 * Unpack one archive into `destDir`.
 *
 * `unzip` is not guaranteed on minimal Linux images, so a zip falls back to
 * Python's stdlib `zipfile` — the desktop runtime already ships a managed
 * interpreter, and a host without either is a host that cannot run skill
 * scripts anyway.
 */
function extractArchive(archivePath: string, destDir: string): void {
  if (archiveKind(archivePath) === 'tar') {
    runExtractor('tar', ['-xf', archivePath, '-C', destDir]);
    return;
  }

  try {
    runExtractor('unzip', ['-q', '-o', archivePath, '-d', destDir]);
    return;
  } catch (unzipError) {
    try {
      runExtractor('python3', ['-m', 'zipfile', '-e', archivePath, destDir]);
      return;
    } catch {
      const detail = unzipError instanceof Error ? unzipError.message : String(unzipError);
      throw new Error(
        `Failed to extract skill archive ${basename(archivePath)}: neither "unzip" nor "python3 -m zipfile" could read it (${detail})`,
      );
    }
  }
}

/**
 * Reject an extracted tree that reaches outside its own directory.
 *
 * `unzip` and `tar` already refuse absolute and `../` member paths, but neither
 * stops a *symlink* member from pointing at `/etc` — and the install step copies
 * the tree verbatim into the workspace.
 */
function assertNoEscapingSymlinks(dir: string, root: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = realpathSync(entryPath);
      } catch {
        // Dangling symlink: it resolves to nothing, so it can leak nothing.
        continue;
      }
      if (target !== root && !target.startsWith(root + '/')) {
        throw new Error(`Skill archive contains a symlink pointing outside the package: ${entry.name}`);
      }
      continue;
    }
    if (entry.isDirectory()) {
      assertNoEscapingSymlinks(entryPath, root);
    }
  }
}

function visibleEntries(dir: string): Array<{ name: string; path: string; isDirectory: boolean }> {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !IGNORED_ENTRIES.has(entry.name) && !entry.name.startsWith('._'))
    .map((entry) => ({
      name: entry.name,
      path: join(dir, entry.name),
      isDirectory: entry.isDirectory(),
    }));
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'mozi-skill-archive-'));
}

/**
 * Find `SKILL.md` in an extracted tree.
 *
 * Real packages take three shapes: `SKILL.md` at the root, a single wrapper
 * directory holding it, or a `.skill`/zip sitting next to unrelated sample
 * files (the shape produced by "zip up the skill and the spreadsheet I used").
 */
function locateSkillFile(dir: string, tempDirs: string[], depth = 0): string | null {
  if (depth > MAX_LOCATE_DEPTH) return null;

  const direct = join(dir, 'SKILL.md');
  if (existsSync(direct)) return direct;

  const entries = visibleEntries(dir);

  const directories = entries.filter((entry) => entry.isDirectory);
  const withSkillFile = directories.filter((entry) => existsSync(join(entry.path, 'SKILL.md')));
  if (withSkillFile.length === 1) {
    return join(withSkillFile[0]!.path, 'SKILL.md');
  }
  if (withSkillFile.length > 1) {
    throw new Error(
      `Skill archive contains ${withSkillFile.length} skills (${withSkillFile.map((entry) => entry.name).join(', ')}); install one at a time with source_path pointing at the one you want`,
    );
  }

  const nestedArchives = entries.filter((entry) => !entry.isDirectory && isSkillArchivePath(entry.path));
  if (nestedArchives.length === 1) {
    const nestedDir = makeTempDir();
    tempDirs.push(nestedDir);
    extractArchive(nestedArchives[0]!.path, nestedDir);
    assertNoEscapingSymlinks(nestedDir, realpathSync(nestedDir));
    return locateSkillFile(nestedDir, tempDirs, depth + 1);
  }
  if (nestedArchives.length > 1) {
    throw new Error(
      `Skill archive contains ${nestedArchives.length} nested skill packages (${nestedArchives.map((entry) => entry.name).join(', ')}); install one at a time`,
    );
  }

  if (directories.length === 1) {
    return locateSkillFile(directories[0]!.path, tempDirs, depth + 1);
  }

  return null;
}

/**
 * Extract a skill archive and return the `SKILL.md` inside it.
 *
 * The caller owns `tempDirs` and must remove them once the skill has been
 * copied into place.
 */
export function extractSkillFromArchive(archivePath: string): ExtractedSkillArchive {
  const resolved = resolve(archivePath);
  if (!existsSync(resolved) || !lstatSync(resolved).isFile()) {
    throw new Error(`Skill archive not found: ${archivePath}`);
  }

  const tempDirs: string[] = [];
  const destDir = makeTempDir();
  tempDirs.push(destDir);

  extractArchive(resolved, destDir);
  assertNoEscapingSymlinks(destDir, realpathSync(destDir));

  const skillFilePath = locateSkillFile(destDir, tempDirs);
  if (!skillFilePath) {
    throw new Error(
      `No SKILL.md found inside ${basename(resolved)}. A skill package must contain SKILL.md at its root, in a single top-level directory, or in a single nested .skill/.zip.`,
    );
  }

  return { skillFilePath, tempDirs };
}
