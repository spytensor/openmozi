import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import pino from 'pino';
import type { ToolDefinition } from '../core/llm.js';
import { getConfig } from '../config/index.js';
import { getDb } from '../store/db.js';
import { ALL_TOOLS } from './definitions.js';
import { isCodingWorkerConfigured } from './delegation-tools.js';
import { isAnySearchProviderConfigured } from '../core/service-providers.js';

const logger = pino({ name: 'mozi:tools:dynamic-registry' });
const execFileAsync = promisify(execFile);

const MAX_SCRIPT_SIZE_BYTES = 10 * 1024;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
const TOOL_ARGS_ENV_VAR = 'MOZI_DYNAMIC_TOOL_ARGS_JSON';
const BUILTIN_TOOL_ENV_REQUIREMENTS: Record<string, string[]> = {};

/** connector_execute can only ever fail without at least one connector credential. */
const CONNECTOR_ENV_VARS = [
  'SLACK_BOT_TOKEN',
  'GITHUB_TOKEN',
  'GMAIL_ACCESS_TOKEN',
  'GOOGLE_ACCESS_TOKEN',
  'GOOGLE_CALENDAR_ACCESS_TOKEN',
];

function isAnyConnectorConfigured(): boolean {
  return CONNECTOR_ENV_VARS.some(name => Boolean(process.env[name]?.trim()));
}

/** Desktop control needs a GUI session: macOS, or Linux with a display server. */
function isDesktopControlAvailable(): boolean {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'linux') {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return false;
}

/** browser_* tools need Playwright, an optional runtime dependency in pruned installs. */
let playwrightResolvable: boolean | null = null;
function isPlaywrightAvailable(): boolean {
  if (playwrightResolvable === null) {
    try {
      createRequire(import.meta.url).resolve('playwright');
      playwrightResolvable = true;
    } catch {
      playwrightResolvable = false;
    }
  }
  return playwrightResolvable;
}

function isCodingWorkerDelegationAvailable(): boolean {
  // Lazy import to keep module init order stable; both modules are leaf-safe.
  try {
    return isCodingWorkerConfigured(getConfig());
  } catch {
    return false;
  }
}

/**
 * Built-in tools gated by a custom predicate rather than a fixed env-var list.
 * A tool that cannot possibly succeed under the current config/host must not
 * be registered — exposing it would claim capability the runtime does not
 * have (Capability Truthfulness), and every unusable definition costs prompt
 * tokens on every turn. All predicates depend only on config/env/host state,
 * so the tool set stays stable within a session (prompt-cache safe).
 */
const BUILTIN_TOOL_PREDICATES: Record<string, () => boolean> = {
  web_search: isAnySearchProviderConfigured,
  web_fetch: isAnySearchProviderConfigured,
  connector_execute: isAnyConnectorConfigured,
  delegate_coding_task: isCodingWorkerDelegationAvailable,
  browser_open: isPlaywrightAvailable,
  browser_click: isPlaywrightAvailable,
  browser_type: isPlaywrightAvailable,
  browser_extract: isPlaywrightAvailable,
  browser_assert: isPlaywrightAvailable,
  desktop_screenshot: isDesktopControlAvailable,
  desktop_list_windows: isDesktopControlAvailable,
  desktop_focus_window: isDesktopControlAvailable,
  desktop_launch_app: isDesktopControlAvailable,
  desktop_click: isDesktopControlAvailable,
  desktop_type: isDesktopControlAvailable,
  desktop_hotkey: isDesktopControlAvailable,
  desktop_click_hint: isDesktopControlAvailable,
  desktop_type_hint: isDesktopControlAvailable,
};

/**
 * Runtime shape for a user-created dynamic tool.
 */
export type DynamicToolStatus = 'draft' | 'active' | 'deprecated';

export interface DynamicTool {
  name: string;
  description: string;
  parameters_schema: string;
  handler_type: 'bash' | 'python';
  handler_path: string;
  status?: DynamicToolStatus;
  use_count?: number;
  failure_count?: number;
  last_used_at?: string | null;
  created_at: string;
}

interface DynamicToolRow extends DynamicTool {
  id: number;
  tenant_id: string;
  status: DynamicToolStatus;
  use_count: number;
  failure_count: number;
  last_used_at: string | null;
}

const dynamicRegistry = new Map<string, DynamicTool>();

function resolveTenantId(tenantId?: string): string {
  return tenantId ?? process.env.MOZI_TENANT_ID ?? 'default';
}

function registryKey(tenantId: string, name: string): string {
  return `${tenantId}:${name}`;
}

function clearTenantRegistry(tenantId: string): void {
  for (const key of dynamicRegistry.keys()) {
    if (key.startsWith(`${tenantId}:`)) {
      dynamicRegistry.delete(key);
    }
  }
}

function getWorkspaceDir(): string {
  const dir = getConfig().workspace.dir;
  if (dir.startsWith('~/') || dir === '~') {
    return resolve(homedir(), dir.slice(2) || '.');
  }
  return resolve(dir);
}

function getWorkspaceToolsDir(): string {
  return resolve(getWorkspaceDir(), 'tools');
}

function isPathInsideDir(baseDir: string, targetPath: string): boolean {
  const normalizedBase = resolve(baseDir);
  const normalizedTarget = resolve(targetPath);
  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${sep}`);
}

function validateToolName(name: string): void {
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid tool name "${name}". Name must be snake_case.`);
  }
}

function validateParametersSchema(schemaText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(schemaText);
  } catch {
    throw new Error('Invalid "parameters_schema": must be a valid JSON string.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid "parameters_schema": expected a JSON object.');
  }
}

function ensureNoBuiltInConflict(name: string): void {
  const builtInNames = new Set(ALL_TOOLS.map(t => t.function.name));
  if (builtInNames.has(name)) {
    throw new Error(`Tool name "${name}" conflicts with a built-in tool.`);
  }
}

function validateHandlerPath(path: string): string {
  const resolvedPath = resolve(path);
  const toolsDir = getWorkspaceToolsDir();

  if (!isPathInsideDir(toolsDir, resolvedPath)) {
    throw new Error('Dynamic tool scripts must be inside workspace/tools/.');
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`Dynamic tool script not found: ${resolvedPath}`);
  }
  const stats = statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error(`Dynamic tool script must be a file: ${resolvedPath}`);
  }
  if (stats.size > MAX_SCRIPT_SIZE_BYTES) {
    throw new Error(`Dynamic tool script exceeds 10KB limit: ${resolvedPath}`);
  }
  return resolvedPath;
}

function toToolDefinition(tool: DynamicTool): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: JSON.parse(tool.parameters_schema) as Record<string, unknown>,
    },
  };
}

function hasRequiredEnvVars(requirements: string[]): boolean {
  return requirements.every((key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function isBuiltInToolEnabled(toolName: string): boolean {
  const predicate = BUILTIN_TOOL_PREDICATES[toolName];
  if (predicate) {
    return predicate();
  }
  const requirements = BUILTIN_TOOL_ENV_REQUIREMENTS[toolName];
  if (!requirements || requirements.length === 0) {
    return true;
  }
  return hasRequiredEnvVars(requirements);
}

function getEnabledBuiltInTools(): ToolDefinition[] {
  return ALL_TOOLS.filter((tool) => isBuiltInToolEnabled(tool.function.name));
}

function normalizeCliArg(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildScriptArgs(args: Record<string, unknown>): string[] {
  return Object.values(args ?? {}).map(normalizeCliArg);
}

function extractExecErrorDetails(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string };
  return (e.stderr || e.stdout || e.message || 'Unknown error').trim();
}

function shouldRetryPythonWithJsonArg(details: string): boolean {
  return /jsondecodeerror|json\.decoder\.jsondecodeerror|expecting value: line \d+ column \d+/i.test(details);
}

async function runDynamicToolScript(
  command: string,
  commandArgs: string[],
  args: Record<string, unknown>,
): Promise<string> {
  const { stdout } = await execFileAsync(command, commandArgs, {
    cwd: getWorkspaceToolsDir(),
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      [TOOL_ARGS_ENV_VAR]: JSON.stringify(args ?? {}),
    },
  });
  return stdout.replace(/[\r\n]+$/, '');
}

function hydrateDynamicTool(row: DynamicToolRow): DynamicTool {
  validateToolName(row.name);
  ensureNoBuiltInConflict(row.name);
  validateParametersSchema(row.parameters_schema);
  const handlerPath = validateHandlerPath(row.handler_path);

  return {
    name: row.name,
    description: row.description,
    parameters_schema: row.parameters_schema,
    handler_type: row.handler_type,
    handler_path: handlerPath,
    status: row.status ?? 'draft',
    use_count: Number.isFinite(row.use_count) ? row.use_count : 0,
    failure_count: Number.isFinite(row.failure_count) ? row.failure_count : 0,
    last_used_at: row.last_used_at ?? null,
    created_at: row.created_at,
  };
}

function syncDynamicToolLifecycle(
  tenantId: string,
  toolName: string,
  patch: Partial<Pick<DynamicToolRow, 'status' | 'use_count' | 'failure_count' | 'last_used_at'>>,
): void {
  const sets: string[] = [];
  const values: Array<string | number | null> = [];

  if (patch.status) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (typeof patch.use_count === 'number') {
    sets.push('use_count = ?');
    values.push(patch.use_count);
  }
  if (typeof patch.failure_count === 'number') {
    sets.push('failure_count = ?');
    values.push(patch.failure_count);
  }
  if (patch.last_used_at !== undefined) {
    sets.push('last_used_at = ?');
    values.push(patch.last_used_at);
  }
  if (sets.length === 0) return;

  const db = getDb();
  db.prepare(`
    UPDATE dynamic_tools
    SET ${sets.join(', ')}
    WHERE tenant_id = ? AND name = ?
  `).run(...values, tenantId, toolName);
}

function loadDynamicToolByName(name: string, tenantId?: string): DynamicTool | null {
  const effectiveTenantId = resolveTenantId(tenantId);
  const db = getDb();
  const row = db.prepare(`
    SELECT
      id, tenant_id, name, description, parameters_schema, handler_type, handler_path,
      status, use_count, failure_count, last_used_at, created_at
    FROM dynamic_tools
    WHERE tenant_id = ? AND name = ?
    LIMIT 1
  `).get(effectiveTenantId, name) as DynamicToolRow | undefined;

  if (!row) {
    return null;
  }

  try {
    const tool = hydrateDynamicTool(row);
    if (tool.status === 'deprecated') {
      dynamicRegistry.delete(registryKey(effectiveTenantId, tool.name));
      return null;
    }
    dynamicRegistry.set(registryKey(effectiveTenantId, tool.name), tool);
    return tool;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: row.name, err: message }, 'Skipping invalid dynamic tool row');
    return null;
  }
}

/**
 * Returns true if a dynamic tool is present in runtime registry.
 */
export function isDynamicToolRegistered(name: string, tenantId?: string): boolean {
  const effectiveTenantId = resolveTenantId(tenantId);
  return dynamicRegistry.has(registryKey(effectiveTenantId, name));
}

/**
 * Returns true if a dynamic tool exists either in runtime registry or SQLite.
 */
export function isDynamicToolAvailable(name: string, tenantId?: string): boolean {
  const effectiveTenantId = resolveTenantId(tenantId);
  if (dynamicRegistry.has(registryKey(effectiveTenantId, name))) {
    return true;
  }
  return loadDynamicToolByName(name, effectiveTenantId) !== null;
}

/**
 * Save a dynamic tool to SQLite and add it to runtime registry.
 */
export function registerDynamicTool(tool: DynamicTool, tenantId?: string): void {
  const effectiveTenantId = resolveTenantId(tenantId);
  validateToolName(tool.name);
  ensureNoBuiltInConflict(tool.name);
  validateParametersSchema(tool.parameters_schema);
  const handlerPath = validateHandlerPath(tool.handler_path);

  const createdAt = tool.created_at || new Date().toISOString();
  const normalized: DynamicTool = {
    ...tool,
    handler_path: handlerPath,
    status: tool.status ?? 'draft',
    use_count: tool.use_count ?? 0,
    failure_count: tool.failure_count ?? 0,
    last_used_at: tool.last_used_at ?? null,
    created_at: createdAt,
  };

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO dynamic_tools (
        tenant_id,
        name,
        description,
        parameters_schema,
        handler_type,
        handler_path,
        status,
        use_count,
        failure_count,
        last_used_at,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      effectiveTenantId,
      normalized.name,
      normalized.description,
      normalized.parameters_schema,
      normalized.handler_type,
      normalized.handler_path,
      normalized.status,
      normalized.use_count,
      normalized.failure_count,
      normalized.last_used_at,
      normalized.created_at,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      throw new Error(`Tool "${tool.name}" already exists.`);
    }
    throw err;
  }

  dynamicRegistry.set(registryKey(effectiveTenantId, normalized.name), normalized);
}

/**
 * Remove a dynamic tool from SQLite and runtime registry.
 */
export function unregisterDynamicTool(name: string, tenantId?: string): void {
  const effectiveTenantId = resolveTenantId(tenantId);
  const db = getDb();
  db.prepare('DELETE FROM dynamic_tools WHERE tenant_id = ? AND name = ?').run(effectiveTenantId, name);
  dynamicRegistry.delete(registryKey(effectiveTenantId, name));
}

/**
 * Return all dynamic tools as OpenAI function definitions.
 */
export function getDynamicTools(tenantId?: string): ToolDefinition[] {
  const effectiveTenantId = resolveTenantId(tenantId);
  const definitions: ToolDefinition[] = [];
  for (const [key, tool] of dynamicRegistry.entries()) {
    if (!key.startsWith(`${effectiveTenantId}:`)) continue;
    if (tool.status === 'deprecated') continue;
    try {
      definitions.push(toToolDefinition(tool));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: tool.name, err: message }, 'Skipping invalid dynamic tool definition');
    }
  }
  return definitions;
}

/**
 * Execute a registered dynamic tool script with positional args and env var JSON.
 */
export async function executeDynamicTool(
  name: string,
  args: Record<string, unknown>,
  tenantId?: string,
): Promise<string> {
  const effectiveTenantId = resolveTenantId(tenantId);
  const tool = dynamicRegistry.get(registryKey(effectiveTenantId, name)) ?? loadDynamicToolByName(name, effectiveTenantId);
  if (!tool) {
    throw new Error(`Dynamic tool "${name}" not found.`);
  }
  if (tool.status === 'deprecated') {
    throw new Error(`Dynamic tool "${name}" is deprecated due to repeated failures.`);
  }

  const scriptPath = validateHandlerPath(tool.handler_path);
  const command = tool.handler_type === 'python' ? 'python3' : 'bash';
  const positionalArgs = buildScriptArgs(args);
  const commandArgs = [scriptPath, ...positionalArgs];
  const jsonArgCommandArgs = [scriptPath, JSON.stringify(args ?? {}), ...positionalArgs];
  let stdout: string | null = null;
  let lastErr: unknown = null;

  try {
    stdout = await runDynamicToolScript(command, commandArgs, args);
  } catch (err) {
    lastErr = err;
    const details = extractExecErrorDetails(err);
    if (tool.handler_type === 'python' && shouldRetryPythonWithJsonArg(details)) {
      logger.warn({ tool: name }, 'Python dynamic tool failed JSON parse with positional args; retrying with JSON first arg');
      try {
        stdout = await runDynamicToolScript(command, jsonArgCommandArgs, args);
        lastErr = null;
      } catch (retryErr) {
        lastErr = retryErr;
      }
    }
  }

  if (stdout !== null) {
    const nextUseCount = (tool.use_count ?? 0) + 1;
    const nextStatus: DynamicToolStatus = tool.status === 'draft' ? 'active' : (tool.status ?? 'draft');
    const now = new Date().toISOString();
    tool.use_count = nextUseCount;
    tool.status = nextStatus;
    tool.last_used_at = now;
    tool.failure_count = tool.failure_count ?? 0;
    syncDynamicToolLifecycle(effectiveTenantId, tool.name, {
      status: nextStatus,
      use_count: nextUseCount,
      last_used_at: now,
    });
    return stdout;
  }

  const details = extractExecErrorDetails(lastErr);
  const nextFailureCount = (tool.failure_count ?? 0) + 1;
  const nextStatus: DynamicToolStatus = nextFailureCount >= 3 ? 'deprecated' : (tool.status ?? 'draft');
  const now = new Date().toISOString();
  tool.failure_count = nextFailureCount;
  tool.last_used_at = now;
  tool.status = nextStatus;
  syncDynamicToolLifecycle(effectiveTenantId, tool.name, {
    status: nextStatus,
    failure_count: nextFailureCount,
    last_used_at: now,
  });
  if (nextStatus === 'deprecated') {
    dynamicRegistry.delete(registryKey(effectiveTenantId, tool.name));
  }
  throw new Error(`Dynamic tool "${name}" failed: ${details}`);
}

/**
 * Load persisted dynamic tools from SQLite into runtime registry.
 */
export function loadDynamicToolsFromDb(tenantId?: string): void {
  const effectiveTenantId = resolveTenantId(tenantId);
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      id, tenant_id, name, description, parameters_schema, handler_type, handler_path,
      status, use_count, failure_count, last_used_at, created_at
    FROM dynamic_tools
    WHERE tenant_id = ?
    ORDER BY id ASC
  `).all(effectiveTenantId) as DynamicToolRow[];

  clearTenantRegistry(effectiveTenantId);

  for (const row of rows) {
    try {
      const tool = hydrateDynamicTool(row);
      if (tool.status === 'deprecated') continue;
      dynamicRegistry.set(registryKey(effectiveTenantId, tool.name), tool);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ tool: row.name, err: message }, 'Skipping invalid dynamic tool row');
    }
  }
}

/**
 * Merge built-in and dynamic tool definitions.
 */
export function getAllRegisteredTools(tenantId?: string): ToolDefinition[] {
  return [...getEnabledBuiltInTools(), ...getDynamicTools(tenantId)];
}
