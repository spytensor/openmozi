/**
 * Declarative agent manifest — parse agent.toml / agent.yaml into a
 * validated AgentManifest, then convert to the registry input format.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import yaml from 'js-yaml';
import type { AgentDefinitionSchema } from './registry.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:agent-manifest' });

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ModelFallbackSchema = z.object({
  provider: z.string(),
  model: z.string(),
});

const ModelConfigSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  fallbacks: z.array(ModelFallbackSchema).default([]),
}).default({ fallbacks: [] });

const CapabilitiesSchema = z.object({
  tools: z.array(z.string()).default([]),
  allowed_domains: z.array(z.string()).default([]),
}).default({ tools: [], allowed_domains: [] });

const ResourcesSchema = z.object({
  max_tokens_per_hour: z.number().positive().optional(),
  max_tool_calls_per_turn: z.number().positive().optional(),
  timeout_seconds: z.number().positive().optional(),
}).optional();

const GuardrailsSchema = z.object({
  approval_required: z.array(z.string()).default([]),
  blocked: z.array(z.string()).default([]),
}).optional();

const SystemPromptRefSchema = z.union([
  z.string(),
  z.object({ file: z.string() }),
]).optional();

export const AgentManifestSchema = z.object({
  agent: z.object({
    name: z.string(),
    version: z.string().default('1.0.0'),
    description: z.string().default(''),
    author: z.string().default(''),
  }),
  model: ModelConfigSchema,
  capabilities: CapabilitiesSchema,
  resources: ResourcesSchema,
  system_prompt: SystemPromptRefSchema,
  guardrails: GuardrailsSchema,
});

export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse an agent manifest file (TOML or YAML).
 * Validates against AgentManifestSchema and resolves system_prompt file refs.
 *
 * @param filePath - Absolute path to agent.toml / agent.yaml / agent.yml
 * @returns Validated AgentManifest
 * @throws On read error, parse error, or Zod validation failure
 */
export function parseManifestFile(filePath: string): AgentManifest {
  const content = readFileSync(filePath, 'utf-8');
  const ext = extname(filePath).toLowerCase();

  let raw: unknown;
  if (ext === '.toml') {
    raw = parseToml(content);
  } else if (ext === '.yaml' || ext === '.yml') {
    raw = yaml.load(content);
  } else {
    throw new Error(`Unsupported manifest format: ${ext} (expected .toml, .yaml, or .yml)`);
  }

  const result = AgentManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid agent manifest at ${filePath}:\n${issues}`);
  }

  const manifest = result.data;

  // Resolve system_prompt file reference
  if (manifest.system_prompt && typeof manifest.system_prompt === 'object' && 'file' in manifest.system_prompt) {
    const promptPath = join(dirname(filePath), manifest.system_prompt.file);
    if (!existsSync(promptPath)) {
      throw new Error(`System prompt file not found: ${promptPath} (referenced in ${filePath})`);
    }
    (manifest as { system_prompt: string }).system_prompt = readFileSync(promptPath, 'utf-8');
  }

  return manifest;
}

// ---------------------------------------------------------------------------
// Conversion to registry input
// ---------------------------------------------------------------------------

/** Derive permission level from tool whitelist. */
function derivePermissionLevel(tools: string[]): string {
  if (tools.length === 0) return 'L0_READ_ONLY';
  const toolSet = new Set(tools.map(t => t.toLowerCase()));
  if (toolSet.has('shell_exec') || toolSet.has('shell')) return 'L2_SHELL_EXEC';
  if (toolSet.has('write_file') || toolSet.has('edit_file') || toolSet.has('filesystem')) return 'L1_READ_WRITE';
  return 'L0_READ_ONLY';
}

/**
 * Convert a parsed AgentManifest to the input format expected by
 * the agent registry's `register()` function.
 */
export function manifestToRegistryInput(
  manifest: AgentManifest,
  agentId: string,
  _agentDir: string,
): z.input<typeof AgentDefinitionSchema> {
  const tools = manifest.capabilities?.tools ?? [];

  return {
    id: agentId,
    name: manifest.agent.name,
    type: 'preset' as const,
    system_prompt: typeof manifest.system_prompt === 'string' ? manifest.system_prompt : undefined,
    tools_allowed: tools,
    permission_level: derivePermissionLevel(tools),
    config: {
      version: manifest.agent.version,
      description: manifest.agent.description,
      author: manifest.agent.author,
      model: manifest.model,
      resources: manifest.resources,
      guardrails: manifest.guardrails,
      allowed_domains: manifest.capabilities?.allowed_domains ?? [],
    },
    created_by: 'manifest',
  };
}
