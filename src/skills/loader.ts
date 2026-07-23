/**
 * File-based skill loader for MOZI.
 *
 * Skills are SKILL.md files with YAML frontmatter + markdown instructions.
 * Inspired by OpenClaw's simple, file-driven approach.
 */

import { access, readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import pino from 'pino';
import yaml from 'js-yaml';

const logger = pino({ name: 'mozi:skill-loader' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SkillRequirements {
  bins?: string[];        // ALL must exist on PATH
  anyBins?: string[];     // AT LEAST ONE must exist
  env?: string[];         // ALL env vars must be set
}

export interface SkillInstallSpec {
  kind: 'brew' | 'npm' | 'pip' | 'manual';
  formula?: string;       // brew formula
  package?: string;       // npm/pip package
  /** Exact runtime import/module names provided by this dependency. Used by
   * dependency-failure recovery; the runtime never guesses package names from
   * untrusted error text. */
  imports?: string[];
  bins?: string[];        // binaries this installs
  label?: string;         // human-readable install label
  command?: string;       // manual install command
}

export interface SkillMetadata {
  emoji?: string;
  priority?: number;        // injection priority (lower = earlier, default 50)
  channels?: string[];      // channel filter (e.g. ['telegram', 'websocket'])
  sandbox_profile?: string; // optional runtime permission profile label
}

export interface SkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  version?: string;                       // semver (e.g. '1.0.0')
  category?: 'utility' | 'coding' | 'research' | 'communication' | 'media' | 'system';
  'user-invocable'?: boolean;
  'disable-model-invocation'?: boolean;
  always?: boolean;
  requires?: SkillRequirements;
  install?: SkillInstallSpec[];
  metadata?: SkillMetadata;
  /**
   * Extension field: set to `"autogen"` by Brain-driven `propose_skill` (#258)
   * so downstream listings can hide unpromoted autogen skills by default.
   * Unknown origin values pass through as-is.
   */
  origin?: string;
  /** Extension field: originating task id for audit trails (populated by #258). */
  source_task_id?: string;
}

export interface LoadedSkill {
  name: string;
  description: string;
  instructions: string;
  frontmatter: SkillFrontmatter;
  filePath: string;
  directoryName: string;
  source: 'bundled' | 'workspace';
  enabled: boolean;
  eligible: boolean;
  missingBins?: string[];
  missingEnv?: string[];
}

export interface SkillDiscoveryOptions {
  bundledDir: string;
  workspaceDir: string;
  /**
   * Discovery is used in the hot prompt path, so it is cached briefly by
   * default. Pass false in tests or one-off callers that require a cold scan.
   */
  useCache?: boolean;
}

export interface SkillLoadResult {
  skill: LoadedSkill;
  instructions: string;
  directoryPath: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse a SKILL.md file into frontmatter + markdown body.
 * Uses js-yaml for YAML parsing.
 */
export function parseSkillFile(content: string): {
  frontmatter: SkillFrontmatter;
  instructions: string;
} {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    throw new Error('SKILL.md is missing YAML frontmatter (--- delimiters)');
  }

  const rawYaml = match[1];
  const instructions = (match[2] ?? '').trim();

  const parsed = yaml.load(rawYaml);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('SKILL.md frontmatter is not a valid YAML object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj.name !== 'string' || !obj.name) {
    throw new Error('SKILL.md frontmatter missing required field: name');
  }
  if (typeof obj.description !== 'string' || !obj.description) {
    throw new Error('SKILL.md frontmatter missing required field: description');
  }

  const frontmatter: SkillFrontmatter = {
    name: obj.name,
    description: obj.description,
  };

  if (typeof obj.license === 'string') {
    frontmatter.license = obj.license;
  }
  if (typeof obj.version === 'string') {
    frontmatter.version = obj.version;
  }
  if (typeof obj.category === 'string') {
    const validCategories = ['utility', 'coding', 'research', 'communication', 'media', 'system'];
    if (validCategories.includes(obj.category)) {
      frontmatter.category = obj.category as SkillFrontmatter['category'];
    }
  }
  if (obj.metadata && typeof obj.metadata === 'object') {
    const meta = obj.metadata as Record<string, unknown>;
    const skillMeta: SkillMetadata = {};
    if (typeof meta.emoji === 'string') skillMeta.emoji = meta.emoji;
    if (typeof meta.priority === 'number') skillMeta.priority = meta.priority;
    if (Array.isArray(meta.channels)) skillMeta.channels = meta.channels.map(String);
    if (typeof meta.sandbox_profile === 'string') skillMeta.sandbox_profile = meta.sandbox_profile;
    frontmatter.metadata = skillMeta;
  }
  if ('user-invocable' in obj) {
    frontmatter['user-invocable'] = Boolean(obj['user-invocable']);
  }
  if ('disable-model-invocation' in obj) {
    frontmatter['disable-model-invocation'] = Boolean(obj['disable-model-invocation']);
  }
  if ('always' in obj) {
    frontmatter.always = Boolean(obj.always);
  }
  if (obj.requires && typeof obj.requires === 'object') {
    const req = obj.requires as Record<string, unknown>;
    const requirements: SkillRequirements = {};
    if (Array.isArray(req.bins)) requirements.bins = req.bins.map(String);
    if (Array.isArray(req.anyBins)) requirements.anyBins = req.anyBins.map(String);
    if (Array.isArray(req.env)) requirements.env = req.env.map(String);
    frontmatter.requires = requirements;
  }
  if (Array.isArray(obj.install)) {
    frontmatter.install = (obj.install as Record<string, unknown>[]).map((item) => {
      const spec: SkillInstallSpec = {
        kind: String(item.kind) as SkillInstallSpec['kind'],
      };
      if (item.formula) spec.formula = String(item.formula);
      if (item.package) spec.package = String(item.package);
      if (Array.isArray(item.imports)) spec.imports = item.imports.map(String);
      if (Array.isArray(item.bins)) spec.bins = item.bins.map(String);
      if (item.label) spec.label = String(item.label);
      if (item.command) spec.command = String(item.command);
      return spec;
    });
  }
  if (typeof obj.origin === 'string') {
    frontmatter.origin = obj.origin;
  }
  if (typeof obj.source_task_id === 'string') {
    frontmatter.source_task_id = obj.source_task_id;
  }

  return { frontmatter, instructions };
}

// ---------------------------------------------------------------------------
// Requirements gating
// ---------------------------------------------------------------------------

const SAFE_BIN_NAME = /^[a-zA-Z0-9_][a-zA-Z0-9._-]*$/;
const SKILL_DISCOVERY_CACHE_TTL_MS = 30_000;

const discoveryCache = new Map<string, { expiresAtMs: number; skills: LoadedSkill[] }>();

/**
 * Check if a binary exists on PATH using `which`.
 * Validates binary name to prevent command injection.
 */
function binaryExists(bin: string, env: NodeJS.ProcessEnv): boolean {
  if (!SAFE_BIN_NAME.test(bin)) {
    logger.warn({ bin }, 'Rejecting unsafe binary name in skill requirements');
    return false;
  }
  try {
    execFileSync('which', [bin], { stdio: 'pipe', env });
    return true;
  } catch {
    return false;
  }
}

export function isModelInvocableSkill(skill: LoadedSkill): boolean {
  return skill.enabled && skill.eligible && !skill.frontmatter['disable-model-invocation'];
}

export function getModelInvocableSkills(skills: LoadedSkill[]): LoadedSkill[] {
  return skills.filter(isModelInvocableSkill);
}

/**
 * Check if a skill's requirements are met on this system.
 */
export async function checkRequirements(
  requires: SkillRequirements | undefined,
): Promise<{ eligible: boolean; missingBins?: string[]; missingEnv?: string[] }> {
  if (!requires) {
    return { eligible: true };
  }

  const missingBins: string[] = [];
  const missingEnv: string[] = [];
  // Requirement truth must be measured in the same environment shell commands
  // actually receive. Checking the parent PATH can disagree with the managed
  // interpreter/overlay selected by the desktop runtime.
  const { getManagedShellEnv } = await import('../capabilities/shell.js');
  const executionEnv = await getManagedShellEnv();

  // bins: ALL must exist
  if (requires.bins) {
    for (const bin of requires.bins) {
      if (!binaryExists(bin, executionEnv)) {
        missingBins.push(bin);
      }
    }
  }

  // anyBins: AT LEAST ONE must exist
  if (requires.anyBins && requires.anyBins.length > 0) {
    const anyFound = requires.anyBins.some((bin) => binaryExists(bin, executionEnv));
    if (!anyFound) {
      missingBins.push(...requires.anyBins.map((b) => `(any of: ${b})`));
    }
  }

  // env: ALL must be set
  if (requires.env) {
    for (const envVar of requires.env) {
      // Environment requirements may be consumed by the runtime/connector
      // itself rather than a child shell. Preserve that long-standing contract
      // while binary probes remain pinned to the effective shell environment.
      if (!process.env[envVar] && !executionEnv[envVar]) {
        missingEnv.push(envVar);
      }
    }
  }

  const eligible = missingBins.length === 0 && missingEnv.length === 0;

  return {
    eligible,
    ...(missingBins.length > 0 ? { missingBins } : {}),
    ...(missingEnv.length > 0 ? { missingEnv } : {}),
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Scan a directory for subdirectories containing SKILL.md files.
 * Returns an array of { dirName, filePath, content } for each found skill.
 */
async function scanSkillDir(
  baseDir: string,
): Promise<Array<{ dirName: string; filePath: string; content: string; enabled: boolean }>> {
  const results: Array<{ dirName: string; filePath: string; content: string; enabled: boolean }> = [];

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    // Directory doesn't exist — that's fine
    return results;
  }

  for (const entry of entries) {
    const skillPath = join(baseDir, entry, 'SKILL.md');
    const disabledMarkerPath = join(baseDir, entry, '.disabled');
    try {
      const content = await readFile(skillPath, 'utf-8');
      const enabled = await access(disabledMarkerPath)
        .then(() => false)
        .catch(() => true);
      results.push({ dirName: entry, filePath: skillPath, content, enabled });
    } catch {
      // No SKILL.md in this subdirectory — skip
    }
  }

  return results;
}

/**
 * Discover and load all SKILL.md files from given directories.
 * Directories searched in order (later wins on name conflict):
 * 1. bundled: bundledDir/\*\/SKILL.md
 * 2. workspace: workspaceDir/\*\/SKILL.md
 */
function discoveryCacheKey(options: SkillDiscoveryOptions): string {
  return `${options.bundledDir}\0${options.workspaceDir}`;
}

export function clearSkillDiscoveryCache(): void {
  discoveryCache.clear();
}

async function discoverSkillsUncached(options: SkillDiscoveryOptions): Promise<LoadedSkill[]> {
  const skillMap = new Map<string, LoadedSkill>();

  const sources: Array<{ dir: string; source: LoadedSkill['source'] }> = [
    { dir: options.bundledDir, source: 'bundled' },
    { dir: options.workspaceDir, source: 'workspace' },
  ];

  for (const { dir, source } of sources) {
    const files = await scanSkillDir(dir);

    for (const { dirName, filePath, content, enabled } of files) {
      try {
        const { frontmatter, instructions } = parseSkillFile(content);
        const reqResult = await checkRequirements(frontmatter.requires);

        const skill: LoadedSkill = {
          name: frontmatter.name,
          description: frontmatter.description,
          instructions,
          frontmatter,
          filePath,
          directoryName: dirName,
          source,
          enabled,
          eligible: enabled && (frontmatter.always ? true : reqResult.eligible),
          ...(reqResult.missingBins ? { missingBins: reqResult.missingBins } : {}),
          ...(reqResult.missingEnv ? { missingEnv: reqResult.missingEnv } : {}),
        };

        // Later source wins on name conflict
        skillMap.set(skill.name, skill);

        logger.debug({ skill: skill.name, source, eligible: skill.eligible }, 'loaded skill');
      } catch (err) {
        logger.warn({ filePath, err }, 'failed to load skill');
      }
    }
  }

  return Array.from(skillMap.values());
}

export async function discoverSkills(options: SkillDiscoveryOptions): Promise<LoadedSkill[]> {
  if (options.useCache === false) {
    return discoverSkillsUncached(options);
  }

  const key = discoveryCacheKey(options);
  const now = Date.now();
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAtMs > now) {
    return cached.skills;
  }

  const skills = await discoverSkillsUncached(options);
  discoveryCache.set(key, { expiresAtMs: now + SKILL_DISCOVERY_CACHE_TTL_MS, skills });
  return skills;
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

export function formatSkillCatalogLine(skill: Pick<LoadedSkill, 'name' | 'description'>): string {
  return `- ${skill.name}: ${skill.description}`;
}

export function formatSkillsForPrompt(skills: LoadedSkill[]): string {
  const eligible = getModelInvocableSkills(skills);

  if (eligible.length === 0) return '';

  const catalog = [
    '## Available Skills',
    'Call `use_skill` with the exact skill name to activate full instructions under `## Active Skills`; active skills expire a few turns after activation, so call `use_skill` again if the procedure is needed later (or `unload_skill` to end it early).',
    'When a task matches a workflow skill below (research, documents, data analysis, creative writing, finance, runtime self-diagnosis), activate it BEFORE planning or calling decompose_task — the loaded checklist shapes a better plan and costs one cheap tool call.',
    ...eligible.map(formatSkillCatalogLine),
  ].join('\n');

  const alwaysSkills = eligible.filter(skill => skill.frontmatter.always === true);
  if (alwaysSkills.length === 0) {
    return catalog;
  }

  const alwaysSections = alwaysSkills.map((s) => {
    const parts = [`### ${s.name}`, s.description, '', s.instructions];
    return parts.join('\n');
  });

  return `${catalog}\n\n## Always-On Skills\n\n${alwaysSections.join('\n\n---\n\n')}`;
}

async function loadFreshSkillFromPath(skill: LoadedSkill): Promise<LoadedSkill> {
  const content = await readFile(skill.filePath, 'utf-8');
  const { frontmatter, instructions } = parseSkillFile(content);
  const reqResult = await checkRequirements(frontmatter.requires);
  const directoryPath = dirname(skill.filePath);
  const enabled = await access(join(directoryPath, '.disabled'))
    .then(() => false)
    .catch(() => true);

  const freshSkill: LoadedSkill = {
    ...skill,
    name: frontmatter.name,
    description: frontmatter.description,
    instructions,
    frontmatter,
    enabled,
    eligible: enabled && (frontmatter.always ? true : reqResult.eligible),
  };
  delete freshSkill.missingBins;
  delete freshSkill.missingEnv;
  if (reqResult.missingBins) freshSkill.missingBins = reqResult.missingBins;
  if (reqResult.missingEnv) freshSkill.missingEnv = reqResult.missingEnv;
  return freshSkill;
}

export async function loadSkillForModelInvocation(
  name: string,
  options: SkillDiscoveryOptions,
): Promise<SkillLoadResult> {
  const requestedName = name.trim();
  if (!requestedName) {
    throw new Error('Skill name is required');
  }

  const discovered = await discoverSkills(options);
  const cachedSkill = discovered.find(skill => skill.name === requestedName);
  if (!cachedSkill) {
    throw new Error(`Unknown or ineligible skill "${requestedName}". No catalog line exists for this name. Use a skill name exactly as shown in the Available Skills catalog.`);
  }

  const skill = await loadFreshSkillFromPath(cachedSkill);
  if (!isModelInvocableSkill(skill)) {
    const reasons: string[] = [];
    if (!skill.enabled) reasons.push('disabled');
    if (!skill.eligible) reasons.push('missing requirements');
    if (skill.frontmatter['disable-model-invocation']) reasons.push('model invocation disabled');
    const reasonText = reasons.length > 0 ? reasons.join(', ') : 'not eligible';
    throw new Error(`Unknown or ineligible skill "${requestedName}" (${reasonText}). Catalog line: ${formatSkillCatalogLine(skill)}`);
  }

  return {
    skill,
    instructions: skill.instructions,
    directoryPath: dirname(skill.filePath),
  };
}
