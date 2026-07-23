/**
 * Cold Bootstrap — first-startup initialization with preset agents and any
 * legacy bootstrap skills still present on disk.
 *
 * On first startup (onboarding.completed = false):
 * 1. Discover legacy bootstrap skills from bootstrap/skills/ when present
 * 2. Register bootstrap agents from bootstrap/agents/
 * 3. Set onboarding.completed = true
 *
 * /onboard command re-runs bootstrap.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import * as agentRegistry from '../agents/registry.js';
import { log as logEvent } from '../store/events.js';
import {
  getBootstrapState,
  setBootstrapState,
  isOnboardingCompleted,
  resetTableFlag,
} from '../onboarding/state.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:bootstrap' });

export { resetTableFlag };

export { isOnboardingCompleted };

// ---------------------------------------------------------------------------
// Bootstrap skill loading
// ---------------------------------------------------------------------------

interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  script_path?: string;
  kind?: 'instruction' | 'module' | 'script';
  instructions_md?: string;
}

/**
 * Load and register skills from SKILL.md files in the bootstrap/skills/ directory.
 * Each skill directory should contain a SKILL.md with YAML front matter.
 */
/**
 * Scan legacy bootstrap skills directory and return count of discovered
 * SKILL.md files. Runtime skill discovery now uses root skills/ plus workspace
 * skills; this function only logs legacy files when present.
 */
export function loadBootstrapSkills(bootstrapDir: string): number {
  const skillsDir = join(bootstrapDir, 'skills');
  if (!existsSync(skillsDir)) {
    logger.debug({ dir: skillsDir }, 'Bootstrap skills directory not found; skipping legacy bootstrap skill scan');
    return 0;
  }

  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let found = 0;

  for (const dir of dirs) {
    const skillMdPath = join(skillsDir, dir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      const def = parseSkillMd(content, dir);
      found++;
      logger.info({ skill_id: def.id, name: def.name }, 'Bootstrap skill discovered');
    } catch (err) {
      logger.error({ dir, error: err instanceof Error ? err.message : String(err) }, 'Failed to parse bootstrap skill');
    }
  }

  return found;
}

/**
 * Parse a SKILL.md file to extract skill metadata.
 * Expects YAML front matter between --- delimiters, or falls back to defaults.
 */
export function parseSkillMd(content: string, dirName: string): SkillDefinition {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const instructionsMd = fmMatch ? content.slice(fmMatch[0].length).trim() : content.trim();
  if (fmMatch) {
    const frontMatter = yaml.load(fmMatch[1]) as Record<string, unknown>;
    const scriptPath = frontMatter.script_path as string | undefined;
    const explicitKind = frontMatter.kind as SkillDefinition['kind'] | undefined;
    const inferredKind: SkillDefinition['kind'] = explicitKind
      ?? (scriptPath?.endsWith('.sh') || scriptPath?.endsWith('.py') ? 'script'
        : scriptPath ? 'module' : 'instruction');
    return {
      id: (frontMatter.id as string) ?? dirName,
      name: (frontMatter.name as string) ?? dirName,
      description: (frontMatter.description as string) ?? '',
      version: (frontMatter.version as string) ?? '1.0.0',
      input_schema: frontMatter.input_schema as Record<string, unknown> | undefined,
      output_schema: frontMatter.output_schema as Record<string, unknown> | undefined,
      script_path: scriptPath,
      kind: inferredKind,
      instructions_md: instructionsMd,
    };
  }

  // Fallback: use directory name and first line as description
  const firstLine = content.split('\n').find((l) => l.startsWith('# '));
  return {
    id: dirName,
    name: firstLine ? firstLine.replace(/^#\s*/, '') : dirName,
    description: '',
    version: '1.0.0',
    kind: 'instruction',
    instructions_md: instructionsMd,
  };
}

// ---------------------------------------------------------------------------
// Workspace skill loading (runs every startup, not gated by onboarding)
// ---------------------------------------------------------------------------

/**
 * Load and register skills from SKILL.md files in the workspace/skills/ directory.
 * Unlike bootstrap skills, these run every startup and are not gated by onboarding.
 * Skills are registered with created_by: 'workspace' and status: 'active'.
 *
 * @param workspaceDir - Path to the workspace directory (e.g. ~/.mozi/workspace)
 * @param tenantId     - Tenant ID for scoping (defaults to 'default')
 * @returns Number of newly registered skills
 */
/**
 * Scan workspace skills directory and return count of discovered SKILL.md files.
 * Skills are now file-based — the loader (src/skills/loader.ts) discovers them
 * at runtime. This function ensures the directory exists and logs what was found.
 *
 * @param workspaceDir - Path to the workspace directory (e.g. ~/.mozi/workspace)
 * @param _tenantId    - Tenant ID (unused; kept for API compatibility)
 * @returns Number of discovered skills
 */
export function loadWorkspaceSkills(workspaceDir: string, _tenantId = 'default'): number {
  const skillsDir = join(workspaceDir, 'skills');

  // Create the skills directory if it doesn't exist
  if (!existsSync(skillsDir)) {
    try {
      mkdirSync(skillsDir, { recursive: true });
    } catch (err) {
      logger.warn({ dir: skillsDir, error: err instanceof Error ? err.message : String(err) }, 'Failed to create workspace skills directory');
    }
    return 0;
  }

  const dirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  let found = 0;

  for (const dir of dirs) {
    const skillMdPath = join(skillsDir, dir, 'SKILL.md');
    if (!existsSync(skillMdPath)) continue;

    try {
      const content = readFileSync(skillMdPath, 'utf-8');
      const def = parseSkillMd(content, dir);
      found++;
      logger.info({ skill_id: def.id, name: def.name }, 'Workspace skill discovered');
    } catch (err) {
      logger.error({ dir, error: err instanceof Error ? err.message : String(err) }, 'Failed to parse workspace skill');
    }
  }

  return found;
}

// ---------------------------------------------------------------------------
// Bootstrap agent loading
// ---------------------------------------------------------------------------

/**
 * Load and register agents from YAML files in the bootstrap/agents/ directory.
 */
export function loadBootstrapAgents(bootstrapDir: string): number {
  const agentsDir = join(bootstrapDir, 'agents');
  return agentRegistry.loadPresets(agentsDir);
}

// ---------------------------------------------------------------------------
// Workspace agent loading (runs every startup, not gated by onboarding)
// ---------------------------------------------------------------------------

/**
 * Load and register agents from manifest files in workspace/agents/ directories.
 * Each agent is a directory containing agent.toml or agent.yaml.
 * Unlike bootstrap agents, these run every startup.
 */
export function loadWorkspaceAgents(workspaceDir: string, tenantId = 'default'): number {
  const agentsDir = join(workspaceDir, 'agents');

  if (!existsSync(agentsDir)) {
    try {
      mkdirSync(agentsDir, { recursive: true });
    } catch (err) {
      logger.warn({ dir: agentsDir, error: err instanceof Error ? err.message : String(err) }, 'Failed to create workspace agents directory');
    }
    return 0;
  }

  const dirs = readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  let loaded = 0;

  for (const dir of dirs) {
    const agentDir = join(agentsDir, dir);
    const tomlPath = join(agentDir, 'agent.toml');
    const yamlPath = join(agentDir, 'agent.yaml');
    const ymlPath = join(agentDir, 'agent.yml');

    const manifestPath = existsSync(tomlPath) ? tomlPath
      : existsSync(yamlPath) ? yamlPath
      : existsSync(ymlPath) ? ymlPath
      : null;

    if (!manifestPath) continue;

    try {
      const result = agentRegistry.registerFromManifest(manifestPath, dir, agentDir, tenantId);
      if (result) {
        loaded++;
        logger.info({ agent_id: dir, name: result.name }, 'Workspace agent registered');
      }
    } catch (err) {
      logger.error({ dir, error: err instanceof Error ? err.message : String(err) }, 'Failed to load workspace agent');
    }
  }

  return loaded;
}

// ---------------------------------------------------------------------------
// Main bootstrap function
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  skillsLoaded: number;
  agentsLoaded: number;
  alreadyCompleted: boolean;
}

/**
 * Run the cold bootstrap process.
 *
 * @param bootstrapDir - Path to the bootstrap/ directory
 * @param force        - If true, run even if already completed (for /onboard)
 * @returns Result with counts of loaded skills and agents
 */
export function runBootstrap(bootstrapDir: string, force = false): BootstrapResult {
  if (!force && isOnboardingCompleted()) {
    logger.info('Onboarding already completed, skipping bootstrap');
    return { skillsLoaded: 0, agentsLoaded: 0, alreadyCompleted: true };
  }

  logger.info({ dir: bootstrapDir, force }, 'Starting cold bootstrap');

  const skillsLoaded = loadBootstrapSkills(bootstrapDir);
  const agentsLoaded = loadBootstrapAgents(bootstrapDir);

  setBootstrapState('onboarding.completed', 'true');

  logEvent('bootstrap_completed', 'system', 'bootstrap', {
    skills_loaded: skillsLoaded,
    agents_loaded: agentsLoaded,
    forced: force,
  });

  logger.info({ skills: skillsLoaded, agents: agentsLoaded }, 'Bootstrap completed');

  return { skillsLoaded, agentsLoaded, alreadyCompleted: false };
}

/**
 * Handle /onboard command — re-run bootstrap.
 */
export function handleOnboardCommand(bootstrapDir: string): string {
  const result = runBootstrap(bootstrapDir, true);
  return `Bootstrap completed: ${result.skillsLoaded} skills, ${result.agentsLoaded} agents loaded.`;
}
