import { dirname, basename, isAbsolute, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_PACKAGE_NAME = 'mozi';

function isProjectRoot(candidate: string): boolean {
  const packagePath = resolve(candidate, 'package.json');
  if (!existsSync(packagePath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf-8')) as { name?: unknown };
    return pkg.name === PROJECT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

export function findProjectRootFrom(startPath: string): string | null {
  let current = resolve(startPath);
  while (true) {
    if (isProjectRoot(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function fallbackProjectRoot(): string {
  const moduleParent = dirname(MODULE_DIR);
  if (basename(MODULE_DIR) === 'dist') {
    return moduleParent;
  }
  if (basename(moduleParent) === 'dist') {
    return dirname(moduleParent);
  }
  return resolve(MODULE_DIR, '..', '..');
}

/**
 * Resolve MOZI's installed project root independently from process.cwd().
 * This keeps bootstrap assets and repo-aware tools stable even when the
 * daemon is launched from a workspace or arbitrary shell directory.
 */
export function getRuntimeProjectRoot(): string {
  const override = process.env.MOZI_PROJECT_ROOT?.trim();
  if (override) {
    return resolve(override);
  }

  const candidates = [
    MODULE_DIR,
    process.argv[1] ? dirname(resolve(process.argv[1])) : null,
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const root = findProjectRootFrom(candidate);
    if (root) {
      return root;
    }
  }

  return fallbackProjectRoot();
}

export function resolveFromProjectRoot(...segments: string[]): string {
  return resolve(getRuntimeProjectRoot(), ...segments);
}

export function resolveProjectRelativePath(targetPath: string): string {
  if (isAbsolute(targetPath)) {
    return resolve(targetPath);
  }
  return resolveFromProjectRoot(targetPath);
}
