import { getDb } from '../store/db.js';
import { z } from 'zod';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { parseManifestFile, manifestToRegistryInput } from './manifest.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:agent-registry' });

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const AgentDefinitionSchema = z.object({
  id: z.string(),
  tenant_id: z.string().default('default'),
  name: z.string(),
  type: z.enum(['preset', 'dynamic']),
  system_prompt: z.string().optional(),
  tools_allowed: z.array(z.string()).default([]),
  permission_level: z.string().default('L0_READ_ONLY'),
  config: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['active', 'inactive', 'archived']).default('active'),
  spawn_count: z.number().default(0),
  success_rate: z.number().default(0),
  avg_token_cost: z.number().default(0),
  evolution_score: z.number().default(0),
  created_by: z.string().default('system'),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export interface AgentRecord extends AgentDefinition {
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------

/** Register a new agent definition in the registry */
export function register(input: z.input<typeof AgentDefinitionSchema>): AgentRecord {
  const agent = AgentDefinitionSchema.parse(input);
  const db = getDb();

  db.prepare(`
    INSERT INTO agent_registry (id, tenant_id, name, type, system_prompt, tools_allowed, permission_level, config, status, spawn_count, success_rate, avg_token_cost, evolution_score, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.tenant_id,
    agent.name,
    agent.type,
    agent.system_prompt ?? null,
    JSON.stringify(agent.tools_allowed),
    agent.permission_level,
    agent.config ? JSON.stringify(agent.config) : null,
    agent.status,
    agent.spawn_count,
    agent.success_rate,
    agent.avg_token_cost,
    agent.evolution_score,
    agent.created_by,
  );

  logger.info({ agent_id: agent.id, name: agent.name, type: agent.type }, 'Agent registered');
  return get(agent.id, agent.tenant_id)!;
}

/** Get an agent by ID */
export function get(id: string, tenantId = 'default'): AgentRecord | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM agent_registry WHERE id = ? AND tenant_id = ?
  `).get(id, tenantId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return deserializeRow(row);
}

/** List agents with optional filters */
export function list(
  filters: { tenant_id?: string; type?: string; status?: string } = {}
): AgentRecord[] {
  const db = getDb();
  const tenantId = filters.tenant_id ?? 'default';
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];

  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  const rows = db.prepare(`
    SELECT * FROM agent_registry WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC
  `).all(...params) as Record<string, unknown>[];

  return rows.map(deserializeRow);
}

/** Update an existing agent definition */
export function update(
  id: string,
  updates: Partial<Pick<AgentDefinition, 'name' | 'type' | 'system_prompt' | 'tools_allowed' | 'permission_level' | 'config' | 'status' | 'spawn_count' | 'success_rate' | 'avg_token_cost' | 'evolution_score'>>,
  tenantId = 'default'
): AgentRecord | null {
  const db = getDb();
  const setClauses: string[] = ["updated_at = datetime('now')"];
  const params: unknown[] = [];

  if (updates.name !== undefined) { setClauses.push('name = ?'); params.push(updates.name); }
  if (updates.type !== undefined) { setClauses.push('type = ?'); params.push(updates.type); }
  if (updates.system_prompt !== undefined) { setClauses.push('system_prompt = ?'); params.push(updates.system_prompt); }
  if (updates.tools_allowed !== undefined) { setClauses.push('tools_allowed = ?'); params.push(JSON.stringify(updates.tools_allowed)); }
  if (updates.permission_level !== undefined) { setClauses.push('permission_level = ?'); params.push(updates.permission_level); }
  if (updates.config !== undefined) { setClauses.push('config = ?'); params.push(JSON.stringify(updates.config)); }
  if (updates.status !== undefined) { setClauses.push('status = ?'); params.push(updates.status); }
  if (updates.spawn_count !== undefined) { setClauses.push('spawn_count = ?'); params.push(updates.spawn_count); }
  if (updates.success_rate !== undefined) { setClauses.push('success_rate = ?'); params.push(updates.success_rate); }
  if (updates.avg_token_cost !== undefined) { setClauses.push('avg_token_cost = ?'); params.push(updates.avg_token_cost); }
  if (updates.evolution_score !== undefined) { setClauses.push('evolution_score = ?'); params.push(updates.evolution_score); }

  params.push(id, tenantId);
  db.prepare(`UPDATE agent_registry SET ${setClauses.join(', ')} WHERE id = ? AND tenant_id = ?`).run(...params);

  logger.info({ agent_id: id }, 'Agent updated');
  return get(id, tenantId);
}

/** Remove an agent from the registry */
export function remove(id: string, tenantId = 'default'): boolean {
  const db = getDb();
  const result = db.prepare(`DELETE FROM agent_registry WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
  if (result.changes > 0) {
    logger.info({ agent_id: id }, 'Agent removed');
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Capability query
// ---------------------------------------------------------------------------

/**
 * Find all active agents that have a specific capability.
 * Capabilities are stored in config.capabilities array.
 */
export function findByCapability(capability: string, tenantId = 'default'): AgentRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM agent_registry
    WHERE tenant_id = ? AND status = 'active'
  `).all(tenantId) as Record<string, unknown>[];

  return rows
    .map(deserializeRow)
    .filter(agent => {
      const caps = agent.config?.capabilities;
      return Array.isArray(caps) && caps.includes(capability);
    });
}

/**
 * Find the best agent for a capability (highest evolution_score).
 * Returns null if no agent found with the capability.
 */
export function findBestForCapability(capability: string, tenantId = 'default'): AgentRecord | null {
  const matches = findByCapability(capability, tenantId);
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    if (b.evolution_score !== a.evolution_score) return b.evolution_score - a.evolution_score;
    return b.success_rate - a.success_rate;
  });

  return matches[0];
}

/**
 * Get all unique capabilities registered across all active agents.
 */
export function listCapabilities(tenantId = 'default'): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT config FROM agent_registry
    WHERE tenant_id = ? AND status = 'active' AND config IS NOT NULL
  `).all(tenantId) as Array<{ config: string }>;

  const caps = new Set<string>();
  for (const row of rows) {
    try {
      const config = JSON.parse(row.config);
      if (Array.isArray(config?.capabilities)) {
        for (const c of config.capabilities) {
          if (typeof c === 'string') caps.add(c);
        }
      }
    } catch {
      // Skip rows with invalid JSON config
    }
  }

  return [...caps].sort();
}

/** Increment spawn count for an agent */
export function incrementSpawnCount(id: string, tenantId = 'default'): void {
  const db = getDb();
  db.prepare(`UPDATE agent_registry SET spawn_count = spawn_count + 1, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?`).run(id, tenantId);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPresetDefinitionChanged(
  existing: AgentRecord,
  input: z.input<typeof AgentDefinitionSchema>,
): boolean {
  return existing.name !== input.name
    || existing.type !== input.type
    || (existing.system_prompt ?? '') !== (input.system_prompt ?? '')
    || stableJson(existing.tools_allowed) !== stableJson(input.tools_allowed ?? [])
    || existing.permission_level !== (input.permission_level ?? 'L0_READ_ONLY')
    || stableJson(existing.config ?? {}) !== stableJson(input.config ?? {})
    || existing.status !== (input.status ?? 'active');
}

/** Load preset agents from YAML files in bootstrap/agents/ */
export function loadPresets(agentsDir: string): number {
  if (!existsSync(agentsDir)) return 0;

  const files = readdirSync(agentsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  let loaded = 0;

  for (const file of files) {
    const content = readFileSync(`${agentsDir}/${file}`, 'utf-8');
    const def = yaml.load(content) as Record<string, unknown>;

    if (!def.id || !def.name) continue;

    const input = {
      ...def,
      type: 'preset',
      created_by: 'bootstrap',
    } as z.input<typeof AgentDefinitionSchema>;
    const existing = get(def.id as string);
    if (!existing) {
      register(input);
      loaded++;
      continue;
    }
    if (existing.created_by !== 'bootstrap' || existing.type !== 'preset') {
      continue;
    }
    if (!isPresetDefinitionChanged(existing, input)) {
      continue;
    }
    update(
      existing.id,
      {
        name: input.name,
        type: input.type,
        system_prompt: input.system_prompt,
        tools_allowed: input.tools_allowed ?? [],
        permission_level: input.permission_level ?? 'L0_READ_ONLY',
        config: input.config,
        status: input.status ?? 'active',
      },
      existing.tenant_id,
    );
    loaded++;
  }

  // Also scan directories containing agent.toml / agent.yaml manifests
  const dirs = readdirSync(agentsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const dir of dirs) {
    const agentDir = `${agentsDir}/${dir}`;
    const tomlPath = `${agentDir}/agent.toml`;
    const yamlManifestPath = `${agentDir}/agent.yaml`;
    const ymlManifestPath = `${agentDir}/agent.yml`;

    const manifestPath = existsSync(tomlPath) ? tomlPath
      : existsSync(yamlManifestPath) ? yamlManifestPath
      : existsSync(ymlManifestPath) ? ymlManifestPath
      : null;

    if (!manifestPath) continue;

    try {
      const result = registerFromManifest(manifestPath, dir, agentDir);
      if (result) loaded++;
    } catch (err) {
      logger.warn({ dir, error: err instanceof Error ? err.message : String(err) }, 'Failed to load agent from manifest');
    }
  }

  logger.info({ count: loaded, dir: agentsDir }, 'Preset agents loaded');
  return loaded;
}

/**
 * Register an agent from a declarative manifest file (agent.toml / agent.yaml).
 * Idempotent — skips if agent already registered.
 */
export function registerFromManifest(
  manifestPath: string,
  agentId: string,
  agentDir: string,
  tenantId = 'default',
): AgentRecord | null {
  const manifest = parseManifestFile(manifestPath);
  const input = manifestToRegistryInput(manifest, agentId, agentDir);
  input.tenant_id = tenantId;

  const existing = get(agentId, tenantId);
  if (existing) {
    logger.debug({ agent_id: agentId }, 'Agent already registered from manifest, skipping');
    return existing;
  }

  return register(input);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deserializeRow(row: Record<string, unknown>): AgentRecord {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    name: row.name as string,
    type: row.type as 'preset' | 'dynamic',
    system_prompt: row.system_prompt as string | undefined,
    tools_allowed: row.tools_allowed ? JSON.parse(row.tools_allowed as string) : [],
    permission_level: row.permission_level as string,
    config: row.config ? JSON.parse(row.config as string) : undefined,
    status: row.status as 'active' | 'inactive' | 'archived',
    spawn_count: row.spawn_count as number,
    success_rate: row.success_rate as number,
    avg_token_cost: row.avg_token_cost as number,
    evolution_score: row.evolution_score as number,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}
