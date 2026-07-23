import { existsSync } from 'node:fs';
import { resolve, isAbsolute, basename } from 'node:path';
import { homedir } from 'node:os';
import pino from 'pino';
import { getConfig } from '../config/index.js';
import { getRuntimeProjectRoot } from '../runtime/project-root.js';
import { initTel } from '../tel/index.js';
import {
  create as createCheckpoint,
  recordAfter as recordCheckpointAfter,
  rollback as rollbackCheckpoint,
} from '../tel/checkpoint.js';
import {
  execute as executeTelIntent,
  type ToolResult as TelToolResult,
  type ExecutionContext,
} from '../tel/router.js';
import { isValidLevel } from '../security/permissions.js';
import {
  createApprovalRequest,
  formatApprovalNotification,
  getRequest,
} from '../security/gates.js';
import { savePendingRetry } from '../security/approval-retry.js';
import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { isHighRiskCommand } from '../capabilities/shell.js';
import type { ToolContext, FileCheckpointHandle } from './types.js';
import {
  expandHome,
  getFsPolicy,
  getOutputDir,
  getWorkspaceAllowedRoots,
  getWorkspaceDir,
  ensureToolWorkspaceDir,
  isPathInsideRoot,
} from './workspace-policy.js';
import { getMoziHome, getEnvPath, getSecretsPath, getMasterKeyPath, getJwtSecretPath, getDbPath } from '../paths.js';

export {
  expandHome,
  getOutputDir,
  getWorkspaceDir,
  getWorkspaceAllowedRoots,
  ensureToolWorkspaceDir,
  isPathInsideRoot,
} from './workspace-policy.js';

const logger = pino({ name: 'mozi:tools:utils' });

// ── Path resolution ──

/** Project root directory (for read-only access to src/, docs/, etc.) */
export function getProjectRoot(): string {
  return getRuntimeProjectRoot();
}

function isImplicitMoziHomePath(path: string): boolean {
  return path === '.mozi' || path.startsWith('.mozi/') || path.startsWith('.mozi\\');
}

export function stripWorkspacePrefix(userPath: string, userId?: string): string {
  if (userPath.startsWith('workspace/') || userPath.startsWith('workspace\\')) {
    return userPath.slice('workspace/'.length);
  }
  const mowiMatch = userPath.match(/^\.mozi[/\\]workspace[/\\](.*)/);
  if (mowiMatch) return mowiMatch[1];
  const wsDir = getWorkspaceDir(userId);
  const homePfx = homedir();
  const wsTail = wsDir.startsWith(homePfx) ? wsDir.slice(homePfx.length + 1) : '';
  if (wsTail && (userPath.startsWith(wsTail + '/') || userPath.startsWith(wsTail + '\\'))) {
    return userPath.slice(wsTail.length + 1);
  }
  return userPath;
}

/**
 * Error thrown when a WRITE targets a path outside the active project scope.
 * Carries the offending path so the escalation layer can raise an approval
 * (P3) instead of hard-failing.
 */
export class PathScopeError extends Error {
  constructor(public readonly targetPath: string, public readonly allowedRoots: string[]) {
    super(`Path not allowed by tools.fs.workspace_only policy: ${targetPath}. Allowed roots: ${allowedRoots.join(', ')}`);
    this.name = 'PathScopeError';
  }
}

export function assertFsPathAllowed(
  resolvedPath: string,
  originalPath: string,
  userId?: string,
  allowedRootsOverride?: string[],
): void {
  const { workspaceOnly } = getFsPolicy();
  if (!workspaceOnly) return;
  const allowedRoots = allowedRootsOverride ?? getWorkspaceAllowedRoots(userId);
  const allowed = allowedRoots.some(root => isPathInsideRoot(resolvedPath, root));
  if (!allowed) {
    // Carry the RESOLVED absolute path so the escalation layer can grant its dir.
    throw new PathScopeError(resolvedPath, allowedRoots);
  }
}

/**
 * L3_FULL_ACCESS is the runtime's highest configured access. Scope gating
 * (project-root narrowing + the out-of-scope write approval prompt) is a
 * containment axis for LOWER levels; it is orthogonal to the permission-level
 * action gate (checkPermission) but must not fire once the operator has granted
 * full access. At L3 the effective write allow-list is the full global
 * workspace policy (workspace_only still bounds it — full access is not "any
 * path on disk"), never the narrow project root. L0–L2 keep project scoping and
 * the approval escalation.
 *
 * This is the single policy-layer decision point — do NOT re-add per-tool or
 * per-path scope exceptions elsewhere.
 */
export function isFullAccessContext(context?: ToolContext): boolean {
  const raw = context?.permissionLevel;
  return isValidLevel(raw ?? '') && raw === 'L3_FULL_ACCESS';
}

/**
 * Resolve the WRITE allow-list for a tool call. When the session is scoped to a
 * project (context.workspaceRootPath set) AND the level is below full access,
 * writes are restricted to that root plus the artifact output dir and any
 * per-session grants. At L3_FULL_ACCESS the project narrowing does not apply
 * (the global workspace roots apply). Otherwise the full global workspace roots
 * apply (default, no project selected). Returns undefined when workspace_only
 * is off (unrestricted).
 */
/**
 * MOZI's own credentials, keys, and live database. These are NEVER writable by
 * a file tool, at any access level — full access opens the rest of the MOZI
 * home, but never these (defense in depth: a confused Brain must not be able to
 * erase the operator's API keys or corrupt the database).
 */
function protectedWritePaths(): string[] {
  const db = resolve(getDbPath());
  // Specific credential/key files and the database file (plus its SQLite WAL/SHM
  // siblings) — NOT the whole data/ dir, which also holds regenerable caches,
  // the heartbeat, and the pid file.
  return [
    getEnvPath(),
    getSecretsPath(),
    getMasterKeyPath(),
    getJwtSecretPath(),
    db, `${db}-wal`, `${db}-shm`, `${db}-journal`,
  ].map(p => resolve(p));
}

/** Thrown when a write targets a protected MOZI runtime file (secrets/keys/DB). */
export class SensitiveWriteError extends Error {
  constructor(public readonly targetPath: string) {
    super(`Refusing to write to a protected MOZI runtime file: ${targetPath}. Credentials, encryption keys, and the database are never tool-writable, even at full access.`);
    this.name = 'SensitiveWriteError';
  }
}

/** Hard denylist enforced on every WRITE, regardless of allow-list or level. */
export function assertNotSensitiveWrite(resolvedPath: string): void {
  const target = resolve(resolvedPath);
  for (const protectedPath of protectedWritePaths()) {
    if (target === protectedPath || isPathInsideRoot(target, protectedPath)) {
      throw new SensitiveWriteError(target);
    }
  }
}

export function resolveWriteRoots(context?: ToolContext): string[] | undefined {
  if (!getFsPolicy().workspaceOnly) return undefined;
  // Directories the user approved via the out-of-scope write escalation. Only
  // real absolute paths are grants — non-path sentinels (e.g. the L1 write
  // session marker) are filtered out so they don't resolve to a bogus root.
  const grants = (context?.scopeGrants ?? []).filter(isAbsolute).map(p => resolve(p));
  const scoped = context?.workspaceRootPath?.trim();
  if (scoped && !isFullAccessContext(context)) {
    return Array.from(new Set([resolve(scoped), getOutputDir(), ...grants]));
  }
  // Default (no project selected, or full access): the workspace roots PLUS any
  // approved out-of-scope dirs. Without merging grants here, an approved write
  // still failed the retry — the approval prompt was a dead end whenever no
  // project was scoped (the exact bug: user clicks Allow, write is blocked anyway).
  const roots = [...getWorkspaceAllowedRoots(context?.userId), ...grants];
  // At full access, MOZI's entire home (~/.mozi) is writable without a per-write
  // approval prompt — it is MOZI's own sandbox, not the operator's files. The
  // assertNotSensitiveWrite denylist still hard-protects secrets/keys/DB inside it.
  if (isFullAccessContext(context)) roots.push(resolve(getMoziHome()));
  return Array.from(new Set(roots));
}

export function dedupWorkspaceDir(resolved: string, wsDir: string): string {
  const doubled = wsDir + '/' + wsDir.split('/').slice(-2).join('/');
  if (resolved.includes(doubled)) {
    return resolved.replace(doubled, wsDir);
  }
  const idx = resolved.indexOf(wsDir, wsDir.length);
  if (idx > 0) {
    return wsDir + resolved.slice(idx + wsDir.length);
  }
  return resolved;
}

export function resolveWritePath(
  userPath: string,
  userId?: string,
  allowedRootsOverride?: string[],
  baseDirOverride?: string,
): string {
  const workspaceDir = getWorkspaceDir(userId);
  const { workspaceOnly } = getFsPolicy();
  const expanded = stripWorkspacePrefix(expandHome(userPath), userId);
  if (isAbsolute(expanded)) {
    const absoluteResolved = resolve(expanded);
    assertFsPathAllowed(absoluteResolved, userPath, userId, allowedRootsOverride);
    assertNotSensitiveWrite(absoluteResolved);
    return absoluteResolved;
  }

  if (isImplicitMoziHomePath(expanded)) {
    const moziHomeResolved = resolve(homedir(), expanded);
    assertFsPathAllowed(moziHomeResolved, userPath, userId, allowedRootsOverride);
    assertNotSensitiveWrite(moziHomeResolved);
    return moziHomeResolved;
  }

  // Relative writes resolve under the project root when the session is scoped
  // to one, else the workspace dir (default). SOUL.md: "You cannot write
  // directly to {{PROJECT_ROOT}}/."
  const base = baseDirOverride?.trim() ? resolve(baseDirOverride) : workspaceDir;
  const resolved = base === workspaceDir
    ? dedupWorkspaceDir(resolve(base, expanded), workspaceDir)
    : resolve(base, expanded);
  if (workspaceOnly) {
    assertFsPathAllowed(resolved, userPath, userId, allowedRootsOverride);
  }
  assertNotSensitiveWrite(resolved);
  return resolved;
}

/**
 * Strip a leading repo-name prefix from a relative path so that
 * e.g. "Mozi/src/workers/dispatch.ts" → "src/workers/dispatch.ts"
 * and  "repos/Mozi/src/workers/dispatch.ts" → "src/workers/dispatch.ts".
 * Returns null if no prefix was stripped.
 */
function stripRepoNamePrefix(relPath: string, projectRoot: string): string | null {
  const projectNames = new Set([basename(projectRoot).toLowerCase(), 'mozi']);
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  // "Mozi/src/..." → strip first segment
  if (segments.length >= 2 && projectNames.has(segments[0].toLowerCase())) {
    return segments.slice(1).join('/');
  }

  // "repos/Mozi/src/..." → strip first two segments
  if (segments.length >= 3 && segments[0] === 'repos' && projectNames.has(segments[1].toLowerCase())) {
    return segments.slice(2).join('/');
  }

  return null;
}

export function resolveReadPath(userPath: string, userId?: string, selectedProjectRoot?: string): string {
  const globalProjectRoot = getProjectRoot();
  const workspaceDir = getWorkspaceDir(userId);
  const { workspaceOnly, allowProjectRootRead } = getFsPolicy();
  const expanded = stripWorkspacePrefix(expandHome(userPath), userId);
  const scoped = selectedProjectRoot?.trim() ? resolve(selectedProjectRoot.trim()) : undefined;
  // Allowed READ roots include the SELECTED project, so reading the project the
  // user pointed MOZI at is not blocked by the workspace-only gate. This mirrors
  // resolveWriteRoots — reads must be as project-aware as writes already are.
  const allowed = getReadAllowedPaths(userId, selectedProjectRoot);

  if (isAbsolute(expanded)) {
    const absoluteResolved = resolve(expanded);
    assertFsPathAllowed(absoluteResolved, userPath, userId, allowed);
    return absoluteResolved;
  }

  if (isImplicitMoziHomePath(expanded)) {
    const moziHomeResolved = resolve(homedir(), expanded);
    assertFsPathAllowed(moziHomeResolved, userPath, userId, allowed);
    return moziHomeResolved;
  }

  // When a project is selected, a relative read resolves under THAT project
  // first (the file the user actually pointed MOZI at), falling back to the
  // workspace dir only when it does not exist in the project.
  if (scoped) {
    const projectResolved = resolve(scoped, expanded);
    if (existsSync(projectResolved)) {
      assertFsPathAllowed(projectResolved, userPath, userId, allowed);
      return projectResolved;
    }
    // Try stripping repo name prefix: "Mozi/src/..." → "src/..."
    const stripped = stripRepoNamePrefix(expanded, scoped);
    if (stripped) {
      const strippedResolved = resolve(scoped, stripped);
      if (existsSync(strippedResolved)) {
        assertFsPathAllowed(strippedResolved, userPath, userId, allowed);
        return strippedResolved;
      }
    }
    // not found in the selected project — fall through to workspace resolution
  }

  const workspaceResolved = dedupWorkspaceDir(resolve(workspaceDir, expanded), workspaceDir);
  if (workspaceOnly) {
    assertFsPathAllowed(workspaceResolved, userPath, userId, allowed);
    return workspaceResolved;
  }

  if (existsSync(workspaceResolved)) {
    return workspaceResolved;
  }

  if (allowProjectRootRead) {
    const projectResolved = resolve(globalProjectRoot, expanded);
    if (existsSync(projectResolved)) {
      return projectResolved;
    }

    // Try stripping repo name prefix: "Mozi/src/..." → "src/..."
    const stripped = stripRepoNamePrefix(expanded, globalProjectRoot);
    if (stripped) {
      const strippedResolved = resolve(globalProjectRoot, stripped);
      if (existsSync(strippedResolved)) {
        return strippedResolved;
      }
    }
  }

  return workspaceResolved;
}

export function getReadAllowedPaths(userId?: string, selectedProjectRoot?: string): string[] | undefined {
  if (!getFsPolicy().workspaceOnly) return undefined;
  const roots = getWorkspaceAllowedRoots(userId);
  const scoped = selectedProjectRoot?.trim();
  return scoped ? Array.from(new Set([resolve(scoped), ...roots])) : roots;
}

export function getWriteAllowedPaths(userId?: string): string[] | undefined {
  return getFsPolicy().workspaceOnly ? getWorkspaceAllowedRoots(userId) : undefined;
}

// ── TEL wrapper ──

let telInitialized = false;

function ensureTelInitialized(): void {
  if (telInitialized) return;
  initTel();
  telInitialized = true;
}

export function telErrorMessage(result: TelToolResult): string {
  if (!result.error) return 'Tool execution failed';
  const detail = result.error.error_message ?? result.error.stderr_tail;
  return detail && detail.trim().length > 0
    ? detail
    : 'Tool execution failed';
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isMissingFileError(detail: string): boolean {
  return /ENOENT|no such file|not found/i.test(detail);
}

export async function runTel(
  category: string,
  action: string,
  params: Record<string, unknown>,
  context?: ToolContext,
): Promise<TelToolResult> {
  ensureTelInitialized();
  const config = getConfig();
  const rawLevel = context?.permissionLevel ?? config.security?.default_permission ?? 'L3_FULL_ACCESS';
  const permissionLevel = isValidLevel(rawLevel) ? rawLevel : 'L0_READ_ONLY';
  // Prefer an explicit allow-list the caller put in the intent params (fs tools
  // pass the project-scoped write roots there). Fall back to the context list,
  // then the global workspace roots. This keeps the router's validatePath in
  // sync with the tool-level resolveWritePath gate under project scoping.
  const paramAllowedPaths = Array.isArray((params as { allowed_paths?: unknown }).allowed_paths)
    ? ((params as { allowed_paths?: string[] }).allowed_paths as string[])
    : undefined;
  const allowedPaths = paramAllowedPaths
    ?? context?.allowedPaths
    ?? (getFsPolicy().workspaceOnly ? getWorkspaceAllowedRoots(context?.userId) : undefined);
  const execContext: ExecutionContext = {
    agent_id: context?.agentId ?? `gateway:${context?.chatId ?? 'system'}`,
    permission_level: permissionLevel,
    tenant_id: context?.tenantId ?? 'default',
    ...(allowedPaths ? { allowed_paths: allowedPaths } : {}),
  };
  return executeTelIntent({ category, action, params }, execContext);
}

// ── Approval ──

export function requireShellApprovalIfNeeded(
  command: string,
  approvalRequestId: string | undefined,
  context?: ToolContext,
  toolCallId?: string,
): string | null {
  if (!isHighRiskCommand(command)) return null;

  // Respect config: skip approval if l3_grant is not in hard_gates
  const hardGates = getConfig().security?.hard_gates ?? [];
  if (!hardGates.includes('l3_grant')) return null;

  const tenantId = context?.tenantId ?? 'default';
  if (approvalRequestId) {
    const request = getRequest(approvalRequestId, tenantId);
    if (!request) {
      return `Error: approval_request_id "${approvalRequestId}" not found`;
    }
    if (request.status !== 'approved') {
      return `Error: approval_request_id "${approvalRequestId}" is ${request.status}. Wait for /approve and retry.`;
    }
    return null;
  }

  const request = createApprovalRequest(
    'l3_grant',
    `High-risk shell command requires approval: ${command.slice(0, 120)}`,
    {
      tool: 'shell_exec',
      command,
      chat_id: context?.chatId ?? null,
      tenant_id: tenantId,
    },
    context?.agentId ?? context?.turnId ?? 'tool-executor',
    tenantId,
  );

  if (context?.chatId && toolCallId) {
    try {
      savePendingRetry({
        approvalRequestId: request.id,
        tenantId,
        chatId: context.chatId,
        toolName: 'shell_exec',
        toolArgs: { command },
        toolCallId,
        sessionId: context.turnId,
      });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to save approval retry context');
    }
  }

  return formatApprovalNotification(request);
}

// ── Checkpoint ──

function resolveCheckpointTaskId(context: ToolContext | undefined, toolCallId: string): string {
  return context?.taskId ?? context?.turnId ?? context?.chatId ?? `tool:${toolCallId}`;
}

function getCheckpointFailurePolicy(context: ToolContext | undefined): 'rollback' | 'none' {
  return context?.checkpointFailurePolicy === 'none' ? 'none' : 'rollback';
}

function nextCheckpointStepIndex(taskId: string, tenantId: string): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT COALESCE(MAX(step_index), 0) AS max_step
    FROM checkpoints
    WHERE task_id = ? AND tenant_id = ?
  `).get(taskId, tenantId) as { max_step?: number } | undefined;
  return Number(row?.max_step ?? 0) + 1;
}

function auditCheckpointEvent(
  eventType: string,
  toolCallId: string,
  payload: Record<string, unknown>,
  tenantId: string,
): void {
  try {
    logEvent(eventType, 'tool_call', toolCallId, payload, tenantId);
  } catch (err) {
    logger.warn({
      eventType,
      tool_call_id: toolCallId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to write checkpoint audit event');
  }
}

export function createFileCheckpointHandle(
  paths: string[],
  toolName: string,
  toolCallId: string,
  context?: ToolContext,
): FileCheckpointHandle | null {
  const normalizedPaths = Array.from(new Set(paths.map(path => resolve(path))));
  if (normalizedPaths.length === 0) return null;

  const tenantId = context?.tenantId ?? 'default';
  const taskId = resolveCheckpointTaskId(context, toolCallId);
  const stepIndex = nextCheckpointStepIndex(taskId, tenantId);

  try {
    const checkpoint = createCheckpoint(
      taskId,
      stepIndex,
      normalizedPaths.map(path => ({ path })),
      tenantId,
      {
        rollback_commands: normalizedPaths.map(path => `restore_file ${path}`),
      },
    );

    auditCheckpointEvent('tool_checkpoint_created', toolCallId, {
      tool: toolName,
      checkpoint_id: checkpoint.checkpoint_id,
      task_id: taskId,
      step_index: stepIndex,
      files: normalizedPaths,
    }, tenantId);

    return {
      checkpointId: checkpoint.checkpoint_id,
      tenantId,
      taskId,
      stepIndex,
      paths: normalizedPaths,
    };
  } catch (err) {
    logger.warn({
      tool: toolName,
      tool_call_id: toolCallId,
      task_id: taskId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to create pre-write checkpoint');
    return null;
  }
}

export function finalizeFileCheckpoint(
  handle: FileCheckpointHandle | null,
  toolName: string,
  toolCallId: string,
): void {
  if (!handle) return;
  try {
    recordCheckpointAfter(handle.checkpointId, handle.tenantId);
    auditCheckpointEvent('tool_checkpoint_recorded', toolCallId, {
      tool: toolName,
      checkpoint_id: handle.checkpointId,
      task_id: handle.taskId,
      step_index: handle.stepIndex,
      files: handle.paths,
    }, handle.tenantId);
  } catch (err) {
    auditCheckpointEvent('tool_checkpoint_record_failed', toolCallId, {
      tool: toolName,
      checkpoint_id: handle.checkpointId,
      error: err instanceof Error ? err.message : String(err),
    }, handle.tenantId);
    logger.warn({
      tool: toolName,
      tool_call_id: toolCallId,
      checkpoint_id: handle.checkpointId,
      err: err instanceof Error ? err.message : String(err),
    }, 'Failed to record post-write checkpoint state');
  }
}

export function rollbackFileCheckpoint(
  handle: FileCheckpointHandle | null,
  toolName: string,
  toolCallId: string,
  errorMessage: string,
  context?: ToolContext,
): void {
  if (!handle) return;

  const policy = getCheckpointFailurePolicy(context);
  if (policy === 'none') {
    auditCheckpointEvent('tool_checkpoint_rollback_skipped', toolCallId, {
      tool: toolName,
      checkpoint_id: handle.checkpointId,
      policy,
      reason: errorMessage,
    }, handle.tenantId);
    return;
  }

  try {
    const rollbackResult = rollbackCheckpoint(handle.checkpointId, handle.tenantId);
    auditCheckpointEvent('tool_checkpoint_rollback', toolCallId, {
      tool: toolName,
      checkpoint_id: handle.checkpointId,
      policy,
      reason: errorMessage,
      restored: rollbackResult.restored,
      deleted: rollbackResult.deleted,
    }, handle.tenantId);
  } catch (rollbackErr) {
    const rollbackMessage = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
    auditCheckpointEvent('tool_checkpoint_rollback_failed', toolCallId, {
      tool: toolName,
      checkpoint_id: handle.checkpointId,
      policy,
      reason: errorMessage,
      rollback_error: rollbackMessage,
    }, handle.tenantId);
    logger.warn({
      tool: toolName,
      tool_call_id: toolCallId,
      checkpoint_id: handle.checkpointId,
      err: rollbackMessage,
    }, 'Failed to rollback checkpoint after tool failure');
  }
}

// ── Constants ──

/** Maximum shell command timeout in ms */
export const SHELL_TIMEOUT_MS = 60_000;
export const MAX_DYNAMIC_SCRIPT_SIZE_BYTES = 10 * 1024;
export const DYNAMIC_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
