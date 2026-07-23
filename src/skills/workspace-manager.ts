import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { getWorkspaceDir } from '../tools/tool-utils.js';
import {
  checkRequirements,
  clearSkillDiscoveryCache,
  discoverSkills,
  parseSkillFile,
  type LoadedSkill,
  type SkillFrontmatter,
} from './loader.js';

export interface SkillRuntimeRecord {
  id: string;
  directory_name: string;
  name: string;
  description: string;
  version?: string;
  category?: SkillFrontmatter['category'];
  source: 'bundled' | 'workspace';
  file_path: string;
  enabled: boolean;
  eligible: boolean;
  missing_bins: string[];
  missing_env: string[];
  /** Mirrors `user-invocable` in SKILL.md frontmatter (default false per SKILL-SPEC). */
  user_invocable: boolean;
  sandbox_profile?: string;
  /**
   * Optional origin tag. `"autogen"` marks skills persisted by the Brain via
   * `propose_skill` — hidden from user-facing listings by default until an
   * operator promotes them (see #264 review §8).
   */
  origin?: string;
}

export interface ListRuntimeSkillsOptions {
  /**
   * When false (default), skills with `origin === 'autogen'` are excluded from
   * the result — autogen skills only become visible once an operator explicitly
   * promotes them. Set to true for operator-level diagnostics.
   */
  includeAutogen?: boolean;
}

export interface SkillInstallResult {
  installed: SkillRuntimeRecord;
  overwritten: boolean;
}

export interface SkillManagerPaths {
  bundledDir?: string;
  workspaceDir?: string;
}

export interface SkillDirectoryFile {
  name: string;
  size: number;
}

export interface SkillDetailRecord extends SkillRuntimeRecord {
  frontmatter: SkillFrontmatter;
  content: string;
  files: SkillDirectoryFile[];
}

export class SkillIdError extends Error {
  readonly code = 'skill_invalid_id';
}

export class SkillNotFoundError extends Error {
  readonly code = 'skill_not_found';
}

export class SkillReadOnlyError extends Error {
  readonly code = 'skill_read_only';
}

export class SkillValidationError extends Error {
  readonly code = 'skill_invalid_content';
}

export class SkillPathError extends Error {
  readonly code = 'skill_path_rejected';
}

function resolveSkillPaths(paths: SkillManagerPaths = {}): { bundledDir: string; workspaceDir: string } {
  return {
    bundledDir: resolve(paths.bundledDir ?? join(getRuntimeProjectRoot(), 'skills')),
    workspaceDir: resolve(paths.workspaceDir ?? join(getWorkspaceDir(), 'skills')),
  };
}

function toRuntimeRecord(skill: LoadedSkill): SkillRuntimeRecord {
  const fm = skill.frontmatter;
  const userInvocable = fm['user-invocable'];
  const origin = typeof fm.origin === 'string' ? fm.origin : undefined;
  const sandboxProfile = fm.metadata?.sandbox_profile;
  return {
    id: `${skill.source}:${skill.name}`,
    directory_name: skill.directoryName,
    name: skill.name,
    description: skill.description,
    ...(fm.version ? { version: fm.version } : {}),
    ...(fm.category ? { category: fm.category } : {}),
    source: skill.source,
    file_path: skill.filePath,
    enabled: skill.enabled,
    eligible: skill.eligible,
    missing_bins: skill.missingBins ?? [],
    missing_env: skill.missingEnv ?? [],
    user_invocable: userInvocable === true,
    ...(sandboxProfile ? { sandbox_profile: sandboxProfile } : {}),
    ...(origin ? { origin } : {}),
  };
}

function readFrontmatterFromSkillFile(skillFilePath: string): { frontmatter: SkillFrontmatter; directoryName: string; description: string } {
  const content = readFileSync(skillFilePath, 'utf-8');
  const { frontmatter } = parseSkillFile(content);
  return {
    frontmatter,
    directoryName: basename(dirname(skillFilePath)),
    description: frontmatter.description,
  };
}

function resolveSkillFilePath(inputPath: string): string {
  const resolved = resolve(inputPath);
  if (!existsSync(resolved)) {
    throw new Error(`Skill source not found: ${inputPath}`);
  }
  if (basename(resolved) === 'SKILL.md') {
    return resolved;
  }
  const skillFilePath = join(resolved, 'SKILL.md');
  if (!existsSync(skillFilePath)) {
    throw new Error(`SKILL.md not found in: ${inputPath}`);
  }
  return skillFilePath;
}

function assertSupportedSkillRepoUrl(repoUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new Error(`Invalid repo URL: ${repoUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Skill repo URL must use https');
  }
}

function cloneSkillRepo(repoUrl: string): string {
  assertSupportedSkillRepoUrl(repoUrl);
  const checkoutDir = mkdtempSync(join(tmpdir(), 'mozi-skill-repo-'));
  execFileSync('git', ['clone', '--depth', '1', repoUrl, checkoutDir], {
    stdio: 'pipe',
    timeout: 30_000,
  });
  return checkoutDir;
}

function findSkillDir(identifier: string, baseDir: string): { directoryName: string; skillFilePath: string } | null {
  if (!existsSync(baseDir)) return null;

  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  for (const entry of entries) {
    const skillFilePath = join(baseDir, entry, 'SKILL.md');
    if (!existsSync(skillFilePath)) continue;
    const { frontmatter } = readFrontmatterFromSkillFile(skillFilePath);
    if (entry === identifier || frontmatter.name === identifier) {
      return { directoryName: entry, skillFilePath };
    }
  }

  return null;
}

function decodeIdentifier(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

function parseSkillId(id: string): { source: 'bundled' | 'workspace'; identifier: string } {
  const decoded = decodeIdentifier(id.trim());
  const separator = decoded.indexOf(':');
  if (separator <= 0 || separator === decoded.length - 1) {
    throw new SkillIdError('Skill id must use source:name format');
  }

  const source = decoded.slice(0, separator);
  if (source !== 'bundled' && source !== 'workspace') {
    throw new SkillIdError('Skill id source must be bundled or workspace');
  }

  const identifier = decoded.slice(separator + 1).trim();
  if (
    !identifier
    || identifier.includes('\0')
    || identifier.includes('/')
    || identifier.includes('\\')
    || identifier.includes('..')
    || identifier === '.'
  ) {
    throw new SkillPathError('Skill id contains an invalid path segment');
  }

  return { source, identifier };
}

function pathInsideRoot(targetPath: string, rootPath: string): boolean {
  const rel = relative(resolve(rootPath), resolve(targetPath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertInsideRoot(targetPath: string, rootPath: string): void {
  if (!pathInsideRoot(targetPath, rootPath)) {
    throw new SkillPathError('Resolved skill path is outside the skills directory');
  }
}

function resolveSkillRef(
  id: string,
  paths: SkillManagerPaths = {},
): {
  source: 'bundled' | 'workspace';
  identifier: string;
  directoryName: string;
  directoryPath: string;
  skillFilePath: string;
  baseDir: string;
} {
  const { source, identifier } = parseSkillId(id);
  const { bundledDir, workspaceDir } = resolveSkillPaths(paths);
  const baseDir = source === 'bundled' ? bundledDir : workspaceDir;
  const found = findSkillDir(identifier, baseDir);
  if (!found) {
    throw new SkillNotFoundError(`Skill not found: ${id}`);
  }

  const baseRealPath = realpathSync(baseDir);
  const directoryPath = realpathSync(join(baseDir, found.directoryName));
  const skillFilePath = realpathSync(found.skillFilePath);
  assertInsideRoot(directoryPath, baseRealPath);
  assertInsideRoot(skillFilePath, directoryPath);

  return {
    source,
    identifier,
    directoryName: found.directoryName,
    directoryPath,
    skillFilePath,
    baseDir: baseRealPath,
  };
}

function listSkillFiles(directoryPath: string): SkillDirectoryFile[] {
  const rootRealPath = realpathSync(directoryPath);
  const files: SkillDirectoryFile[] = [];

  function walk(currentPath: string): void {
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      const stats = lstatSync(fullPath);
      const realPath = realpathSync(fullPath);
      assertInsideRoot(realPath, rootRealPath);

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stats.isFile()) continue;
      files.push({
        name: relative(rootRealPath, fullPath).split(sep).join('/'),
        size: stats.size,
      });
    }
  }

  walk(rootRealPath);
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

async function buildSkillDetail(ref: ReturnType<typeof resolveSkillRef>): Promise<SkillDetailRecord> {
  const content = readFileSync(ref.skillFilePath, 'utf-8');
  const { frontmatter, instructions } = parseSkillFile(content);
  const requirements = await checkRequirements(frontmatter.requires);
  const enabled = !existsSync(join(ref.directoryPath, '.disabled'));
  const runtime = toRuntimeRecord({
    name: frontmatter.name,
    description: frontmatter.description,
    instructions,
    frontmatter,
    filePath: ref.skillFilePath,
    directoryName: ref.directoryName,
    source: ref.source,
    enabled,
    eligible: enabled && (frontmatter.always ? true : requirements.eligible),
    ...(requirements.missingBins ? { missingBins: requirements.missingBins } : {}),
    ...(requirements.missingEnv ? { missingEnv: requirements.missingEnv } : {}),
  });

  return {
    ...runtime,
    frontmatter,
    content,
    files: listSkillFiles(ref.directoryPath),
  };
}

/**
 * Read a bundled or workspace skill with raw SKILL.md content and bundled files.
 */
export async function getRuntimeSkillDetail(
  id: string,
  paths: SkillManagerPaths = {},
): Promise<SkillDetailRecord> {
  return buildSkillDetail(resolveSkillRef(id, paths));
}

/**
 * Update a workspace SKILL.md after validating that the new content parses.
 */
export async function updateWorkspaceSkillContent(
  id: string,
  content: string,
  paths: SkillManagerPaths = {},
): Promise<SkillDetailRecord> {
  const ref = resolveSkillRef(id, paths);
  if (ref.source !== 'workspace') {
    throw new SkillReadOnlyError('Bundled skills are read-only');
  }

  try {
    parseSkillFile(content);
  } catch (err) {
    throw new SkillValidationError(err instanceof Error ? err.message : String(err));
  }

  writeFileSync(ref.skillFilePath, content, 'utf-8');
  clearSkillDiscoveryCache();
  return getRuntimeSkillDetail(`workspace:${ref.directoryName}`, paths);
}

/**
 * Enable or disable a workspace skill from a REST-style source:name id.
 */
export async function setRuntimeSkillState(
  id: string,
  enabled: boolean,
  paths: SkillManagerPaths = {},
): Promise<SkillRuntimeRecord> {
  const ref = resolveSkillRef(id, paths);
  if (ref.source !== 'workspace') {
    throw new SkillReadOnlyError('Bundled skills are read-only');
  }
  return setWorkspaceSkillState(ref.directoryName, enabled, paths);
}

/**
 * List bundled + workspace runtime skills with current enabled/eligibility state.
 *
 * Autogen skills (`origin: 'autogen'`, produced by Brain-driven `propose_skill`
 * in #258) are excluded by default so they are not visible in `/skills` or
 * `/api/skills` until an operator has reviewed and promoted them. Pass
 * `{ includeAutogen: true }` for operator-level inspection.
 */
export async function listRuntimeSkills(
  paths: SkillManagerPaths = {},
  options: ListRuntimeSkillsOptions = {},
): Promise<SkillRuntimeRecord[]> {
  const { includeAutogen = false } = options;
  const resolved = resolveSkillPaths(paths);
  const loaded = await discoverSkills({
    bundledDir: resolved.bundledDir,
    workspaceDir: resolved.workspaceDir,
  });

  return loaded
    .map(toRuntimeRecord)
    .filter(record => includeAutogen || record.origin !== 'autogen')
    .sort((left, right) => {
      if (left.source !== right.source) {
        return left.source === 'workspace' ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
}

/**
 * Validate one specific skill from bundled or workspace storage.
 */
export async function validateRuntimeSkill(
  identifier: string,
  options: SkillManagerPaths & { source?: 'bundled' | 'workspace' } = {},
): Promise<SkillRuntimeRecord> {
  const { bundledDir, workspaceDir } = resolveSkillPaths(options);
  const source = options.source ?? 'workspace';
  const baseDir = source === 'bundled' ? bundledDir : workspaceDir;

  const candidate = findSkillDir(identifier, baseDir);

  if (!candidate) {
    throw new Error(`Skill not found in ${source}: ${identifier}`);
  }

  const content = readFileSync(candidate.skillFilePath, 'utf-8');
  const { frontmatter, instructions } = parseSkillFile(content);
  const requirements = await checkRequirements(frontmatter.requires);
  const enabled = !existsSync(join(dirname(candidate.skillFilePath), '.disabled'));

  return toRuntimeRecord({
    name: frontmatter.name,
    description: frontmatter.description,
    instructions,
    frontmatter,
    filePath: candidate.skillFilePath,
    directoryName: candidate.directoryName,
    source,
    enabled,
    eligible: enabled && requirements.eligible,
    ...(requirements.missingBins ? { missingBins: requirements.missingBins } : {}),
    ...(requirements.missingEnv ? { missingEnv: requirements.missingEnv } : {}),
  });
}

/**
 * Install a bundled skill or local SKILL.md directory into the workspace skill area.
 */
export async function installWorkspaceSkill(input: {
  source: 'bundled' | 'path' | 'git';
  skill_id?: string;
  source_path?: string;
  repo_url?: string;
  skill_subpath?: string;
  target_name?: string;
  overwrite?: boolean;
  enabled?: boolean;
} & SkillManagerPaths): Promise<SkillInstallResult> {
  const { bundledDir, workspaceDir } = resolveSkillPaths(input);
  const enabled = input.enabled !== false;
  const overwrite = input.overwrite === true;

  let sourceSkillFilePath: string;
  let checkoutDir: string | null = null;

  try {
    if (input.source === 'bundled') {
      if (!input.skill_id?.trim()) {
        throw new Error('"skill_id" is required when source="bundled"');
      }
      sourceSkillFilePath = resolveSkillFilePath(join(bundledDir, input.skill_id.trim()));
    } else if (input.source === 'path') {
      if (!input.source_path?.trim()) {
        throw new Error('"source_path" is required when source="path"');
      }
      sourceSkillFilePath = resolveSkillFilePath(input.source_path.trim());
    } else {
      if (!input.repo_url?.trim()) {
        throw new Error('"repo_url" is required when source="git"');
      }
      checkoutDir = cloneSkillRepo(input.repo_url.trim());
      const checkoutTarget = input.skill_subpath?.trim()
        ? join(checkoutDir, input.skill_subpath.trim())
        : checkoutDir;
      sourceSkillFilePath = resolveSkillFilePath(checkoutTarget);
    }

    const sourceDir = dirname(sourceSkillFilePath);
    const sourceMeta = readFrontmatterFromSkillFile(sourceSkillFilePath);
    const targetName = (input.target_name?.trim() || sourceMeta.directoryName).trim();
    if (!targetName) {
      throw new Error('Unable to resolve target skill directory name');
    }

    mkdirSync(workspaceDir, { recursive: true });
    const targetDir = join(workspaceDir, targetName);
    const targetExists = existsSync(targetDir);
    if (targetExists && !overwrite) {
      throw new Error(`Workspace skill already exists: ${targetName}`);
    }

    if (targetExists && overwrite) {
      rmSync(targetDir, { recursive: true, force: true });
    }

    cpSync(sourceDir, targetDir, { recursive: true });

    const disabledMarkerPath = join(targetDir, '.disabled');
    if (!enabled) {
      writeFileSync(disabledMarkerPath, 'disabled\n', 'utf-8');
    } else if (existsSync(disabledMarkerPath)) {
      unlinkSync(disabledMarkerPath);
    }

    const installed = await validateRuntimeSkill(targetName, {
      workspaceDir,
      bundledDir,
      source: 'workspace',
    });
    clearSkillDiscoveryCache();

    return {
      installed,
      overwritten: targetExists && overwrite,
    };
  } finally {
    if (checkoutDir) {
      rmSync(checkoutDir, { recursive: true, force: true });
    }
  }
}

/**
 * Enable or disable a workspace skill via `.disabled` marker.
 */
export async function setWorkspaceSkillState(
  identifier: string,
  enabled: boolean,
  paths: SkillManagerPaths = {},
): Promise<SkillRuntimeRecord> {
  const { workspaceDir, bundledDir } = resolveSkillPaths(paths);
  const found = findSkillDir(identifier, workspaceDir);
  if (!found) {
    throw new Error(`Workspace skill not found: ${identifier}`);
  }

  const disabledMarkerPath = join(workspaceDir, found.directoryName, '.disabled');
  if (enabled) {
    if (existsSync(disabledMarkerPath)) {
      unlinkSync(disabledMarkerPath);
    }
  } else {
    writeFileSync(disabledMarkerPath, 'disabled\n', 'utf-8');
  }

  const result = await validateRuntimeSkill(found.directoryName, {
    workspaceDir,
    bundledDir,
    source: 'workspace',
  });
  clearSkillDiscoveryCache();
  return result;
}

export function formatRuntimeSkillsCommandOutput(skills: SkillRuntimeRecord[]): string {
  if (skills.length === 0) {
    return 'Skills: none.';
  }

  const lines = [`Skills — ${skills.length}`];
  for (const skill of skills) {
    const state = skill.enabled ? (skill.eligible ? 'enabled' : 'missing_requirements') : 'disabled';
    const extras: string[] = [`source=${skill.source}`, `state=${state}`];
    if (skill.missing_bins.length > 0) extras.push(`missing_bins=${skill.missing_bins.join(',')}`);
    if (skill.missing_env.length > 0) extras.push(`missing_env=${skill.missing_env.join(',')}`);
    lines.push(`- ${skill.name} (${skill.directory_name}) | ${extras.join(' | ')}`);
  }
  return lines.join('\n');
}
