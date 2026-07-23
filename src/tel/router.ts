import { z } from 'zod';
import { get as getSla, getRetryDelay, type ToolSla } from './sla.js';
import { compress as compressError, type ErrorContext } from './error-compress.js';
import { checkPermission, PermissionDeniedError, type PermissionLevel } from '../security/permissions.js';
import { log as logEvent } from '../store/events.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:tel:router' });

// ---------------------------------------------------------------------------
// Intent schema
// ---------------------------------------------------------------------------

export const IntentSchema = z.object({
  category: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()).default(() => ({})),
});

export type Intent = z.infer<typeof IntentSchema>;

// ---------------------------------------------------------------------------
// Execution context (agent info for permission checks)
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  agent_id: string;
  permission_level: string;
  allowed_paths?: string[];
  tenant_id?: string;
}

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface ToolResult {
  success: boolean;
  data: unknown;
  error?: ErrorContext;
  elapsed_ms: number;
  retries: number;
}

export interface RouteResult {
  tool: string;
  validated_params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Path restriction
// ---------------------------------------------------------------------------

/** Absolute deny list — never allow access to these paths */
const ABSOLUTE_DENY_PATHS = [
  '/etc',
  '/root',
] as const;

const ABSOLUTE_DENY_PATTERNS = [
  '/.ssh',
  '/.gnupg',
] as const;

/**
 * Validate that a file path is safe and within allowed boundaries.
 *
 * Rules:
 * 1. No ".." path traversal
 * 2. Not in absolute deny list (/etc, /root, ~/.ssh, ~/.gnupg)
 * 3. If allowed_paths is set, must be under one of them
 *
 * @throws Error if path is restricted
 */
export function validatePath(filePath: string, allowedPaths?: string[], agentId?: string, tenantId = 'default'): void {
  // Normalize: resolve relative components
  const normalized = filePath.replace(/\\/g, '/');

  // Check for path traversal
  if (normalized.includes('..')) {
    const msg = `Path traversal detected: '${filePath}'`;
    logger.warn({ agent_id: agentId, path: filePath }, msg);
    logEvent('path_restriction_violation', 'security', agentId ?? 'unknown', { path: filePath, reason: 'traversal' }, tenantId);
    throw new Error(msg);
  }

  // Check absolute deny list
  for (const deny of ABSOLUTE_DENY_PATHS) {
    if (normalized === deny || normalized.startsWith(deny + '/')) {
      const msg = `Access denied: path '${filePath}' is in deny list`;
      logger.warn({ agent_id: agentId, path: filePath, deny_rule: deny }, msg);
      logEvent('path_restriction_violation', 'security', agentId ?? 'unknown', { path: filePath, reason: 'deny_list', rule: deny }, tenantId);
      throw new Error(msg);
    }
  }

  // Check deny patterns (e.g. /.ssh anywhere in path)
  for (const pattern of ABSOLUTE_DENY_PATTERNS) {
    if (normalized.includes(pattern)) {
      const msg = `Access denied: path '${filePath}' matches deny pattern '${pattern}'`;
      logger.warn({ agent_id: agentId, path: filePath, deny_pattern: pattern }, msg);
      logEvent('path_restriction_violation', 'security', agentId ?? 'unknown', { path: filePath, reason: 'deny_pattern', pattern }, tenantId);
      throw new Error(msg);
    }
  }

  // Check allowed_paths whitelist
  if (allowedPaths && allowedPaths.length > 0) {
    const isAllowed = allowedPaths.some((allowed) =>
      normalized === allowed || normalized.startsWith(allowed.endsWith('/') ? allowed : allowed + '/'),
    );

    if (!isAllowed) {
      const msg = `Access denied: path '${filePath}' is not within allowed paths`;
      logger.warn({ agent_id: agentId, path: filePath, allowed_paths: allowedPaths }, msg);
      logEvent('path_restriction_violation', 'security', agentId ?? 'unknown', { path: filePath, reason: 'not_in_allowed_paths', allowed_paths: allowedPaths }, tenantId);
      throw new Error(msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Parameter schemas per category+action
// ---------------------------------------------------------------------------

const PARAM_SCHEMAS: Record<string, Record<string, z.ZodType>> = {
  shell: {
    execute: z.object({
      command: z.string(),
      timeout: z.number().optional(),
      cwd: z.string().optional(),
      // Decides whose workspace a bare/relative cwd resolves against. Zod strips
      // unknown keys, so omitting it here silently drops the caller's id and the
      // process lands in the shared workspace — which the file API will not serve.
      userId: z.string().optional(),
      restricted: z.boolean().default(false),
      enforceWorkspaceBoundary: z.boolean().optional(),
    }),
    execute_background: z.object({
      command: z.string(),
      cwd: z.string().optional(),
      userId: z.string().optional(),
      restricted: z.boolean().default(false),
      enforceWorkspaceBoundary: z.boolean().optional(),
      chat_id: z.string().optional(),
      tenant_id: z.string().optional(),
    }),
    process_status: z.object({
      process_id: z.string(),
    }),
    process_output: z.object({
      process_id: z.string(),
      tail_lines: z.number().optional(),
    }),
    process_input: z.object({
      process_id: z.string(),
      input: z.string(),
    }),
    process_kill: z.object({
      process_id: z.string(),
      signal: z.string().optional(),
    }),
  },
  blackboard: {
    read: z.object({
      key: z.string().optional(),
      scope: z.string().optional(),
      tenant_id: z.string().optional(),
    }),
    write: z.object({
      key: z.string(),
      value: z.string(),
      scope: z.string().optional(),
      written_by: z.string().optional(),
      tenant_id: z.string().optional(),
    }),
  },
  filesystem: {
    read: z.object({
      path: z.string(),
      allowed_paths: z.array(z.string()).optional(),
    }),
    write: z.object({
      path: z.string(),
      content: z.string(),
      allowed_paths: z.array(z.string()).optional(),
    }),
    list: z.object({
      path: z.string(),
      allowed_paths: z.array(z.string()).optional(),
    }),
    search: z.object({
      path: z.string(),
      pattern: z.string(),
      recursive: z.boolean().default(true),
      allowed_paths: z.array(z.string()).optional(),
    }),
    append: z.object({
      path: z.string(),
      content: z.string(),
      allowed_paths: z.array(z.string()).optional(),
    }),
    delete: z.object({
      path: z.string(),
      allowed_paths: z.array(z.string()).optional(),
    }),
  },
};

// ---------------------------------------------------------------------------
// Tool executor registry
// ---------------------------------------------------------------------------

type ToolExecutor = (params: Record<string, unknown>, context?: ExecutionContext) => Promise<unknown>;
const executors = new Map<string, ToolExecutor>();

/** Register a tool executor function */
export function registerExecutor(category: string, action: string, executor: ToolExecutor): void {
  executors.set(`${category}.${action}`, executor);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Route an intent to a tool, validate parameters, and return routing info.
 * Does NOT execute the tool — use execute() for that.
 */
export function route(intent: z.input<typeof IntentSchema>): RouteResult {
  const parsed = IntentSchema.parse(intent);
  const { category, action, params } = parsed;

  const categorySchemas = PARAM_SCHEMAS[category];
  if (!categorySchemas) {
    throw new Error(`Unknown tool category: ${category}`);
  }

  const paramSchema = categorySchemas[action];
  if (!paramSchema) {
    throw new Error(`Unknown action "${action}" for category "${category}"`);
  }

  const validated = paramSchema.parse(params) as Record<string, unknown>;

  return {
    tool: category,
    validated_params: validated,
  };
}

/**
 * Route, validate, and execute an intent.
 * Handles SLA timeouts, retries, permission checks, and path restrictions.
 *
 * @param intent  - The intent to execute
 * @param context - Optional execution context with agent info for permission/path checks
 */
export async function execute(
  intent: z.input<typeof IntentSchema>,
  context?: ExecutionContext,
): Promise<ToolResult> {
  const { tool, validated_params } = route(intent);
  const parsed = IntentSchema.parse(intent);
  const tenantId = context?.tenant_id ?? 'default';

  // --- Permission check ---
  if (context) {
    checkPermission(
      context.agent_id,
      context.permission_level,
      parsed.category,
      parsed.action,
      tenantId,
    );
  }

  // --- Path restriction check ---
  if (parsed.category === 'filesystem') {
    const filePath = validated_params.path as string | undefined;
    if (filePath) {
      // Merge context allowed_paths with param-level allowed_paths
      const effectivePaths = context?.allowed_paths ??
        (validated_params.allowed_paths as string[] | undefined);
      validatePath(filePath, effectivePaths, context?.agent_id, tenantId);
    }
  }

  const sla = getSla(tool);
  const executorKey = `${parsed.category}.${parsed.action}`;
  const executor = executors.get(executorKey);

  if (!executor) {
    throw new Error(`No executor registered for ${executorKey}`);
  }

  let lastError: ErrorContext | undefined;
  const maxAttempts = sla.retries + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = getRetryDelay(attempt - 1, sla.retry_strategy);
      if (delay > 0) await sleep(delay);
    }

    const startTime = Date.now();

    try {
      const result = await withTimeout(
        executor(validated_params, context),
        sla.timeout * 1000
      );

      return {
        success: true,
        data: result,
        elapsed_ms: Date.now() - startTime,
        retries: attempt,
      };
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errMsg = err instanceof Error ? err.message : String(err);
      lastError = compressError(tool, executorKey, -1, errMsg);

      logger.warn({
        tool: executorKey,
        attempt: attempt + 1,
        max_attempts: maxAttempts,
        elapsed_ms: elapsed,
        error: errMsg,
      }, 'Tool execution failed');
    }
  }

  return {
    success: false,
    data: null,
    error: lastError,
    elapsed_ms: 0,
    retries: maxAttempts - 1,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms`)), ms);
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
