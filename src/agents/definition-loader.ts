/**
 * File-backed AGENT.md definitions for user-managed expert agents.
 *
 * This module is intentionally independent from the legacy agent registry.
 * It discovers definitions for the management surface only; execution is
 * introduced by later batches of EPIC #858.
 */

import { access, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import pino from 'pino';
import { getAllProviders } from '../core/providers.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { discoverSkills } from '../skills/loader.js';
import { getWorkspaceDir } from '../tools/tool-utils.js';
import { PERMISSION_LEVELS, type PermissionLevel } from '../security/permissions.js';

const logger = pino({ name: 'mozi:agent-definition-loader' });
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const CACHE_TTL_MS = 30_000;
const SAFE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface AgentFrontmatter {
  name: string;
  description: string;
  model?: string;
  skills: string[];
  tools?: string[];
  permission_level?: PermissionLevel;
  metadata?: { color?: string };
}

export type AgentDefinitionStatus = 'ready' | 'needs-setup' | 'disabled';

export interface LoadedAgentDefinition {
  id: string;
  name: string;
  description: string;
  model?: string;
  skills: string[];
  tools?: string[];
  permission_level?: PermissionLevel;
  color?: string;
  persona: string;
  content: string;
  filePath: string;
  directoryName: string;
  source: 'bundled' | 'workspace';
  enabled: boolean;
  status: AgentDefinitionStatus;
  missingSkills: string[];
  invalidModel?: string;
  frontmatter: AgentFrontmatter;
}

export interface AgentDefinitionPaths {
  bundledDir?: string;
  workspaceDir?: string;
  bundledSkillsDir?: string;
  workspaceSkillsDir?: string;
  useCache?: boolean;
}

export interface AgentDefinitionInput {
  name: string;
  description: string;
  persona: string;
  model?: string;
  skills?: string[];
  tools?: string[];
  permission_level?: PermissionLevel;
  color?: string;
}

export class AgentDefinitionError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'not_found' | 'read_only' | 'conflict',
  ) {
    super(message);
  }
}

const cache = new Map<string, { expiresAt: number; agents: LoadedAgentDefinition[] }>();

function resolvedPaths(paths: AgentDefinitionPaths = {}) {
  const projectRoot = getRuntimeProjectRoot();
  const workspaceRoot = getWorkspaceDir();
  return {
    bundledDir: resolve(paths.bundledDir ?? join(projectRoot, 'bootstrap', 'agents')),
    workspaceDir: resolve(paths.workspaceDir ?? join(workspaceRoot, 'agents')),
    bundledSkillsDir: resolve(paths.bundledSkillsDir ?? join(projectRoot, 'skills')),
    workspaceSkillsDir: resolve(paths.workspaceSkillsDir ?? join(workspaceRoot, 'skills')),
  };
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new AgentDefinitionError(`AGENT.md frontmatter field "${field}" must be an array of non-empty strings`, 'invalid');
  }
  return [...new Set(value.map(item => String(item).trim()))];
}

/** Parse one AGENT.md document into its typed frontmatter and persona body. */
export function parseAgentDefinition(content: string): { frontmatter: AgentFrontmatter; persona: string } {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) throw new AgentDefinitionError('AGENT.md is missing YAML frontmatter (--- delimiters)', 'invalid');
  const raw = yaml.load(match[1] ?? '');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentDefinitionError('AGENT.md frontmatter is not a valid YAML object', 'invalid');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.name !== 'string' || !value.name.trim()) {
    throw new AgentDefinitionError('AGENT.md frontmatter missing required field: name', 'invalid');
  }
  if (!SAFE_NAME.test(value.name.trim())) {
    throw new AgentDefinitionError('Agent name must use lowercase letters, numbers, hyphens, or underscores', 'invalid');
  }
  if (typeof value.description !== 'string' || !value.description.trim()) {
    throw new AgentDefinitionError('AGENT.md frontmatter missing required field: description', 'invalid');
  }
  const skills = stringArray(value.skills, 'skills') ?? [];
  const tools = stringArray(value.tools, 'tools');
  const permission = value.permission_level;
  if (permission !== undefined && (typeof permission !== 'string' || !PERMISSION_LEVELS.includes(permission as PermissionLevel))) {
    throw new AgentDefinitionError(`Invalid permission_level: ${String(permission)}`, 'invalid');
  }
  let color: string | undefined;
  if (value.metadata !== undefined) {
    if (!value.metadata || typeof value.metadata !== 'object' || Array.isArray(value.metadata)) {
      throw new AgentDefinitionError('AGENT.md metadata must be an object', 'invalid');
    }
    const metadata = value.metadata as Record<string, unknown>;
    if (metadata.color !== undefined && (typeof metadata.color !== 'string' || !metadata.color.trim())) {
      throw new AgentDefinitionError('AGENT.md metadata.color must be a non-empty string', 'invalid');
    }
    color = typeof metadata.color === 'string' ? metadata.color.trim() : undefined;
  }
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
    throw new AgentDefinitionError('AGENT.md model must be a non-empty string', 'invalid');
  }
  return {
    frontmatter: {
      name: value.name.trim(),
      description: value.description.trim(),
      ...(typeof value.model === 'string' ? { model: value.model.trim() } : {}),
      skills,
      ...(tools ? { tools } : {}),
      ...(typeof permission === 'string' ? { permission_level: permission as PermissionLevel } : {}),
      ...(color ? { metadata: { color } } : {}),
    },
    persona: (match[2] ?? '').trim(),
  };
}

/** Serialize a structured definition into the canonical AGENT.md form. */
export function serializeAgentDefinition(input: AgentDefinitionInput): string {
  const normalized: Record<string, unknown> = {
    name: input.name.trim(),
    description: input.description.trim(),
  };
  if (input.model?.trim()) normalized.model = input.model.trim();
  normalized.skills = input.skills ?? [];
  if (input.tools) normalized.tools = input.tools;
  if (input.permission_level) normalized.permission_level = input.permission_level;
  if (input.color?.trim()) normalized.metadata = { color: input.color.trim() };
  const yamlText = yaml.dump(normalized, { lineWidth: -1, noRefs: true }).trimEnd();
  const content = `---\n${yamlText}\n---\n\n${input.persona.trim()}\n`;
  parseAgentDefinition(content);
  return content;
}

function isKnownModel(model: string): boolean {
  const separator = model.indexOf('/');
  if (separator > 0) {
    const providerId = model.slice(0, separator);
    const modelId = model.slice(separator + 1);
    const provider = getAllProviders().find(item => item.id === providerId);
    return Boolean(provider?.models.some(item => item.id === modelId));
  }
  return getAllProviders().some(provider => provider.models.some(item => item.id === model));
}

async function scanRoot(dir: string, source: LoadedAgentDefinition['source']) {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: Array<{
    directoryName: string;
    filePath: string;
    content: string;
    enabled: boolean;
    source: LoadedAgentDefinition['source'];
  }> = [];
  for (const entry of entries) {
    // Refuse symlinked directories so update/delete cannot escape the agent root.
    if (!entry.isDirectory()) continue;
    const directoryName = entry.name;
    const filePath = join(dir, directoryName, 'AGENT.md');
    try {
      const content = await readFile(filePath, 'utf-8');
      const enabled = await access(join(dir, directoryName, '.disabled')).then(() => false).catch(() => true);
      results.push({ directoryName, filePath, content, enabled, source });
    } catch {
      // Entries without AGENT.md are unrelated to this definition loader.
    }
  }
  return results;
}

function cacheKey(paths: ReturnType<typeof resolvedPaths>): string {
  return [paths.bundledDir, paths.workspaceDir, paths.bundledSkillsDir, paths.workspaceSkillsDir].join('\0');
}

let cacheGeneration = 0;

/** Clear the 30-second discovery cache after any filesystem mutation. */
export function clearAgentDefinitionCache(): void {
  cacheGeneration += 1;
  cache.clear();
}

let readyProbeMemo: { generation: number; expiresAt: number; value: boolean } | null = null;

/**
 * Synchronous readiness probe for the production tool registry predicate.
 * Workspace definitions retain the same name-override semantics as discovery.
 * The default-path probe is memoized (30s TTL, invalidated with the discovery
 * cache) because the registry evaluates predicates on every tool execution.
 */
export function hasReadyAgentDefinitionSync(options: AgentDefinitionPaths = {}): boolean {
  const memoizable = !options.bundledDir && !options.workspaceDir
    && !options.bundledSkillsDir && !options.workspaceSkillsDir;
  if (memoizable && readyProbeMemo
    && readyProbeMemo.generation === cacheGeneration
    && readyProbeMemo.expiresAt > Date.now()) {
    return readyProbeMemo.value;
  }
  const paths = resolvedPaths(options);
  const skillNames = new Set<string>();
  for (const dir of [paths.bundledSkillsDir, paths.workspaceSkillsDir]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || existsSync(join(dir, entry.name, '.disabled'))) continue;
        try {
          const parsed = yaml.load(
            readFileSync(join(dir, entry.name, 'SKILL.md'), 'utf-8')
              .match(FRONTMATTER_RE)?.[1] ?? '',
          );
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const name = (parsed as Record<string, unknown>).name;
            if (typeof name === 'string' && name.trim()) skillNames.add(name.trim());
          }
        } catch {
          // Invalid skills cannot make an agent ready.
        }
      }
    } catch {
      // Missing roots contribute no skills.
    }
  }

  const readiness = new Map<string, boolean>();
  for (const dir of [paths.bundledDir, paths.workspaceDir]) {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const disabled = existsSync(join(dir, entry.name, '.disabled'));
          const { frontmatter } = parseAgentDefinition(readFileSync(join(dir, entry.name, 'AGENT.md'), 'utf-8'));
          readiness.set(frontmatter.name, !disabled
            && frontmatter.skills.every(skill => skillNames.has(skill))
            && (!frontmatter.model || isKnownModel(frontmatter.model)));
        } catch {
          // Invalid definitions are not executable.
        }
      }
    } catch {
      // Missing roots contribute no definitions.
    }
  }
  const ready = [...readiness.values()].some(Boolean);
  if (memoizable) {
    readyProbeMemo = { generation: cacheGeneration, expiresAt: Date.now() + CACHE_TTL_MS, value: ready };
  }
  return ready;
}

/** Discover bundled and workspace AGENT.md files; workspace names override bundled names. */
export async function discoverAgentDefinitions(options: AgentDefinitionPaths = {}): Promise<LoadedAgentDefinition[]> {
  const paths = resolvedPaths(options);
  const key = cacheKey(paths);
  const cached = cache.get(key);
  if (options.useCache !== false && cached && cached.expiresAt > Date.now()) return cached.agents;
  const generationAtScanStart = cacheGeneration;

  const discoveredSkills = await discoverSkills({
    bundledDir: paths.bundledSkillsDir,
    workspaceDir: paths.workspaceSkillsDir,
    useCache: options.useCache,
  });
  const skillNames = new Set(discoveredSkills.map(skill => skill.name));
  const byName = new Map<string, LoadedAgentDefinition>();
  for (const [dir, source] of [[paths.bundledDir, 'bundled'], [paths.workspaceDir, 'workspace']] as const) {
    for (const file of await scanRoot(dir, source)) {
      try {
        const { frontmatter, persona } = parseAgentDefinition(file.content);
        const missingSkills = frontmatter.skills.filter(skill => !skillNames.has(skill));
        const invalidModel = frontmatter.model && !isKnownModel(frontmatter.model) ? frontmatter.model : undefined;
        const status: AgentDefinitionStatus = !file.enabled
          ? 'disabled'
          : missingSkills.length > 0 || invalidModel
            ? 'needs-setup'
            : 'ready';
        byName.set(frontmatter.name, {
          id: `${source}:${frontmatter.name}`,
          name: frontmatter.name,
          description: frontmatter.description,
          ...(frontmatter.model ? { model: frontmatter.model } : {}),
          skills: frontmatter.skills,
          ...(frontmatter.tools ? { tools: frontmatter.tools } : {}),
          ...(frontmatter.permission_level ? { permission_level: frontmatter.permission_level } : {}),
          ...(frontmatter.metadata?.color ? { color: frontmatter.metadata.color } : {}),
          persona,
          content: file.content,
          filePath: file.filePath,
          directoryName: file.directoryName,
          source,
          enabled: file.enabled,
          status,
          missingSkills,
          ...(invalidModel ? { invalidModel } : {}),
          frontmatter,
        });
      } catch (error) {
        logger.warn({ filePath: file.filePath, error }, 'Failed to load AGENT.md');
      }
    }
  }
  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (options.useCache !== false && generationAtScanStart === cacheGeneration) {
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, agents });
  }
  return agents;
}

/** Render the enabled file-defined agents for the shared text-command surface. */
export function formatAgentDefinitionsCommandOutput(agents: LoadedAgentDefinition[]): string {
  const enabled = agents.filter(agent => agent.enabled);
  if (enabled.length === 0) return 'No enabled agents.';
  return enabled
    .map(agent => `${agent.name} — ${agent.description} — ${agent.status}`)
    .join('\n');
}

function parseId(id: string): { source: 'bundled' | 'workspace'; name: string } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(id);
  } catch {
    throw new AgentDefinitionError('Invalid agent id encoding', 'invalid');
  }
  const [source, name, ...rest] = decoded.split(':');
  if (rest.length || (source !== 'bundled' && source !== 'workspace') || !name || !SAFE_NAME.test(name)) {
    throw new AgentDefinitionError('Agent id must use bundled:name or workspace:name', 'invalid');
  }
  return { source, name };
}

async function findAgent(id: string, paths: AgentDefinitionPaths = {}): Promise<LoadedAgentDefinition> {
  const parsed = parseId(id);
  const agents = await discoverAgentDefinitions({ ...paths, useCache: false });
  const found = agents.find(agent => agent.source === parsed.source && agent.name === parsed.name);
  if (!found) throw new AgentDefinitionError(`Agent not found: ${id}`, 'not_found');
  return found;
}

/** Read one definition including its original AGENT.md content. */
export async function getAgentDefinition(id: string, paths: AgentDefinitionPaths = {}): Promise<LoadedAgentDefinition> {
  return findAgent(id, paths);
}

/** Create a new workspace definition and invalidate discovery. */
export async function createAgentDefinition(input: AgentDefinitionInput, options: AgentDefinitionPaths = {}): Promise<LoadedAgentDefinition> {
  const content = serializeAgentDefinition(input);
  const { frontmatter } = parseAgentDefinition(content);
  const paths = resolvedPaths(options);
  const targetDir = join(paths.workspaceDir, frontmatter.name);
  await mkdir(paths.workspaceDir, { recursive: true });
  try {
    await access(targetDir);
    throw new AgentDefinitionError(`Workspace agent already exists: ${frontmatter.name}`, 'conflict');
  } catch (error) {
    if (error instanceof AgentDefinitionError) throw error;
  }
  await mkdir(targetDir, { recursive: false });
  await writeFile(join(targetDir, 'AGENT.md'), content, 'utf-8');
  clearAgentDefinitionCache();
  return findAgent(`workspace:${frontmatter.name}`, options);
}

/** Update an existing workspace definition, renaming its directory when needed. */
export async function updateAgentDefinition(id: string, input: AgentDefinitionInput, options: AgentDefinitionPaths = {}): Promise<LoadedAgentDefinition> {
  const existing = await findAgent(id, options);
  if (existing.source === 'bundled') throw new AgentDefinitionError('Bundled agents are read-only', 'read_only');
  const content = serializeAgentDefinition(input);
  const { frontmatter } = parseAgentDefinition(content);
  let filePath = existing.filePath;
  if (frontmatter.name !== existing.name) {
    const paths = resolvedPaths(options);
    const targetDir = join(paths.workspaceDir, frontmatter.name);
    try {
      await access(targetDir);
      throw new AgentDefinitionError(`Workspace agent already exists: ${frontmatter.name}`, 'conflict');
    } catch (error) {
      if (error instanceof AgentDefinitionError) throw error;
    }
    await rename(resolve(existing.filePath, '..'), targetDir);
    filePath = join(targetDir, 'AGENT.md');
  }
  await writeFile(filePath, content, 'utf-8');
  clearAgentDefinitionCache();
  return findAgent(`workspace:${frontmatter.name}`, options);
}

/** Enable or disable one definition using the sibling .disabled marker. */
export async function setAgentDefinitionState(id: string, enabled: boolean, options: AgentDefinitionPaths = {}): Promise<LoadedAgentDefinition> {
  const existing = await findAgent(id, options);
  if (existing.source === 'bundled') throw new AgentDefinitionError('Bundled agents are read-only', 'read_only');
  const marker = join(resolve(existing.filePath, '..'), '.disabled');
  if (enabled) await unlink(marker).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  else await writeFile(marker, 'disabled\n', 'utf-8');
  clearAgentDefinitionCache();
  return findAgent(id, options);
}

/** Delete one workspace definition directory. */
export async function deleteAgentDefinition(id: string, options: AgentDefinitionPaths = {}): Promise<void> {
  const existing = await findAgent(id, options);
  if (existing.source === 'bundled') throw new AgentDefinitionError('Bundled agents are read-only', 'read_only');
  await rm(resolve(existing.filePath, '..'), { recursive: true });
  clearAgentDefinitionCache();
}
