import { getDb } from '../store/db.js';
import { randomUUID } from 'node:crypto';
import type { WorkspaceMessageContext } from '../channels/telegram.js';
import { isValidLevel, type PermissionLevel } from '../security/permissions.js';
import { resolvePersistedRuntimePath } from '../tools/workspace-policy.js';

export const DEFAULT_SESSION_PERMISSION_LEVEL: PermissionLevel = 'L3_FULL_ACCESS';

/** A conversation session (thread) */
export interface Session {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  archived: number;
  message_count: number;
  permission_level: PermissionLevel;
  workspace_root_id?: string | null;
  workspace_context?: WorkspaceMessageContext | null;
  project_root_id?: string | null;
  project_context?: WorkspaceMessageContext | null;
  execution_root_id?: string | null;
  execution_context?: WorkspaceMessageContext | null;
  /** Directories the user granted out-of-project-scope WRITE access to for this session (P3). */
  scope_grants?: string[];
  /** Durable aggregate of any open user/background turn owned by this session. */
  activity_status?: 'running' | 'awaiting_approval' | null;
  activity_started_at?: number | null;
}

export interface SessionActivity {
  status: 'running' | 'awaiting_approval' | null;
  startedAt: number | null;
}

/** Result from getOrCreateSessionForChat — includes stale session info for digest generation */
export interface SessionResult {
  session: Session;
  staleSessionId?: string;
}

/** Options for listing sessions */
export interface ListSessionsOpts {
  tenantId?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface SessionWorkspaceContextInput {
  workspaceRootId?: string | null;
  workspaceContext?: WorkspaceMessageContext | null;
}

/** Generate a unique session ID */
function generateSessionId(): string {
  return `sess-${randomUUID()}`;
}

/** 24 hours in milliseconds */
const SESSION_STALE_MS = 24 * 60 * 60 * 1000;

function timestampToUtcIso(value: string): string {
  const trimmed = value.trim();
  const hasTimeZone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const normalized = hasTimeZone ? trimmed : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function parseSessionTime(value: string): number {
  const parsed = new Date(timestampToUtcIso(value)).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sessionSelect(whereClause: string): string {
  return `
    SELECT
      s.id,
      s.tenant_id,
      s.user_id,
      s.title,
      s.created_at,
      s.updated_at,
      s.archived,
      s.permission_level,
      s.workspace_root_id,
      s.workspace_context,
      s.project_root_id,
      s.project_context,
      s.execution_root_id,
      s.execution_context,
      s.scope_grants,
      (
        SELECT COUNT(*)
        FROM conversations c
        WHERE c.tenant_id = s.tenant_id AND c.session_id = s.id
      ) AS message_count
      ,(
        SELECT CASE
          WHEN EXISTS (
            SELECT 1 FROM session_turns st
            WHERE st.tenant_id = s.tenant_id AND st.session_id = s.id AND st.status = 'awaiting_approval'
          ) THEN 'awaiting_approval'
          WHEN EXISTS (
            SELECT 1 FROM session_turns st
            WHERE st.tenant_id = s.tenant_id AND st.session_id = s.id AND st.status = 'active'
          ) THEN 'running'
          ELSE NULL
        END
      ) AS activity_status
      ,(
        SELECT MIN(st.started_at)
        FROM session_turns st
        WHERE st.tenant_id = s.tenant_id AND st.session_id = s.id
          AND st.status IN ('active', 'awaiting_approval')
      ) AS activity_started_at
    FROM sessions s
    ${whereClause}
  `;
}

function normalizeSession(row: Session): Session {
  const rawProjectContext = row.project_context ?? row.workspace_context;
  const rawExecutionContext = row.execution_context ?? row.workspace_context;
  const projectContext = normalizeWorkspaceContext(rawProjectContext, row.user_id);
  const executionContext = normalizeWorkspaceContext(rawExecutionContext, row.user_id);
  const projectRootId = normalizeRootId(row.project_root_id ?? row.workspace_root_id, rawProjectContext, projectContext);
  const executionRootId = normalizeRootId(row.execution_root_id ?? row.workspace_root_id, rawExecutionContext, executionContext);
  return {
    ...row,
    message_count: Number(row.message_count ?? 0),
    created_at: timestampToUtcIso(row.created_at),
    updated_at: timestampToUtcIso(row.updated_at),
    permission_level: isValidLevel(row.permission_level)
      ? row.permission_level
      : DEFAULT_SESSION_PERMISSION_LEVEL,
    project_root_id: projectRootId,
    project_context: projectContext,
    execution_root_id: executionRootId,
    execution_context: executionContext,
    // Compatibility aliases are execution scope. New grouping code must use
    // project_* and must never infer ownership from these mutable fields.
    workspace_root_id: executionRootId,
    workspace_context: executionContext,
    scope_grants: parseScopeGrants((row as { scope_grants?: unknown }).scope_grants),
    activity_status: row.activity_status ?? null,
    activity_started_at: row.activity_started_at == null ? null : Number(row.activity_started_at),
  };
}

export function getSessionActivity(sessionId: string, tenantId = 'default'): SessionActivity {
  const row = getDb().prepare(`
    SELECT
      CASE
        WHEN SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) > 0 THEN 'awaiting_approval'
        WHEN SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) > 0 THEN 'running'
        ELSE NULL
      END AS status,
      MIN(CASE WHEN status IN ('active', 'awaiting_approval') THEN started_at END) AS started_at
    FROM session_turns
    WHERE tenant_id = ? AND session_id = ?
  `).get(tenantId, sessionId) as { status: SessionActivity['status']; started_at: number | null } | undefined;
  return {
    status: row?.status ?? null,
    startedAt: row?.started_at == null ? null : Number(row.started_at),
  };
}

function normalizeWorkspaceContext(raw: unknown, userId: string): WorkspaceMessageContext | null {
  const parsedWorkspaceContext = typeof raw === 'string'
    ? parseWorkspaceContextJson(raw)
    : (raw as WorkspaceMessageContext | null | undefined) ?? null;
  const originalRootPath = parsedWorkspaceContext?.rootPath;
  const restoredRootPath = originalRootPath
    ? resolvePersistedRuntimePath(originalRootPath, userId)
    : null;
  const workspaceContext = parsedWorkspaceContext && restoredRootPath
    ? { ...parsedWorkspaceContext, rootPath: restoredRootPath }
    : parsedWorkspaceContext;
  return workspaceContext;
}

function normalizeRootId(rootId: string | null | undefined, rawContext: unknown, context: WorkspaceMessageContext | null): string | null {
  let normalized = rootId ?? null;
  const parsed = typeof rawContext === 'string' ? parseWorkspaceContextJson(rawContext) : rawContext as WorkspaceMessageContext | null;
  const originalRootPath = parsed?.rootPath;
  const restoredRootPath = context?.rootPath;
  if (originalRootPath && restoredRootPath && normalized) {
    if (normalized === originalRootPath) normalized = `${context?.rootKind ?? 'project_root'}:${restoredRootPath}`;
    else if (normalized.endsWith(originalRootPath)) normalized = `${normalized.slice(0, -originalRootPath.length)}${restoredRootPath}`;
  }
  return normalized;
}

function parseScopeGrants(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === 'string');
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Read the directories the user has granted out-of-scope write access to for a session. */
export function getSessionScopeGrants(id: string, tenantId = 'default'): string[] {
  const db = getDb();
  const row = db.prepare('SELECT scope_grants FROM sessions WHERE id = ? AND tenant_id = ?').get(id, tenantId) as
    | { scope_grants?: unknown }
    | undefined;
  return row ? parseScopeGrants(row.scope_grants) : [];
}

/** Add a directory to a session's out-of-scope write grants (idempotent). Returns the new set. */
export function addSessionScopeGrant(id: string, dir: string, tenantId = 'default'): string[] {
  const current = getSessionScopeGrants(id, tenantId);
  if (current.includes(dir)) return current;
  const next = [...current, dir];
  const db = getDb();
  db.prepare("UPDATE sessions SET scope_grants = ?, updated_at = datetime('now') WHERE id = ? AND tenant_id = ?")
    .run(JSON.stringify(next), id, tenantId);
  return next;
}

function parseWorkspaceContextJson(raw: string): WorkspaceMessageContext | null {
  try {
    const parsed = JSON.parse(raw) as WorkspaceMessageContext;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Create a new session.
 */
export function createSession(
  userId: string,
  title = 'New Chat',
  tenantId = 'default',
  context: SessionWorkspaceContextInput = {},
): Session {
  const db = getDb();
  const id = generateSessionId();
  db.prepare(`
    INSERT INTO sessions (id, tenant_id, user_id, title, workspace_root_id, workspace_context,
      project_root_id, project_context, execution_root_id, execution_context)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    tenantId,
    userId,
    title,
    context.workspaceRootId ?? null,
    context.workspaceContext ? JSON.stringify(context.workspaceContext) : null,
    context.workspaceRootId ?? null,
    context.workspaceContext ? JSON.stringify(context.workspaceContext) : null,
    context.workspaceRootId ?? null,
    context.workspaceContext ? JSON.stringify(context.workspaceContext) : null,
  );

  return normalizeSession(db.prepare(sessionSelect('WHERE s.id = ?')).get(id) as Session);
}

/**
 * Get a session by ID.
 */
export function getSession(id: string, tenantId = 'default'): Session | null {
  const db = getDb();
  const row = db.prepare(sessionSelect('WHERE s.id = ? AND s.tenant_id = ?')).get(id, tenantId) as Session | undefined;
  return row ? normalizeSession(row) : null;
}

/**
 * List sessions for a user, ordered by most recently updated.
 */
export function listSessions(
  userId: string,
  opts: ListSessionsOpts = {},
): Session[] {
  const { tenantId = 'default', limit = 50, offset = 0, includeArchived = false } = opts;
  const db = getDb();

  if (includeArchived) {
    const rows = db.prepare(`
      ${sessionSelect('WHERE s.tenant_id = ? AND s.user_id = ?')}
      ORDER BY s.updated_at DESC, s.rowid DESC
      LIMIT ? OFFSET ?
    `).all(tenantId, userId, limit, offset) as Session[];
    return rows.map(normalizeSession);
  }

  const rows = db.prepare(`
    ${sessionSelect('WHERE s.tenant_id = ? AND s.user_id = ? AND s.archived = 0')}
    ORDER BY s.updated_at DESC, s.rowid DESC
    LIMIT ? OFFSET ?
  `).all(tenantId, userId, limit, offset) as Session[];
  return rows.map(normalizeSession);
}

/**
 * Count sessions for a user.
 */
export function countSessions(
  userId: string,
  opts: { tenantId?: string; includeArchived?: boolean } = {},
): number {
  const { tenantId = 'default', includeArchived = false } = opts;
  const db = getDb();

  if (includeArchived) {
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM sessions
      WHERE tenant_id = ? AND user_id = ?
    `).get(tenantId, userId) as { cnt: number };
    return row.cnt;
  }

  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM sessions
    WHERE tenant_id = ? AND user_id = ? AND archived = 0
  `).get(tenantId, userId) as { cnt: number };
  return row.cnt;
}

/**
 * Update a session's title.
 */
export function updateTitle(id: string, title: string, tenantId = 'default'): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET title = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(title, id, tenantId);
}

export function getSessionPermissionLevel(id: string, tenantId = 'default'): PermissionLevel | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT permission_level FROM sessions
    WHERE id = ? AND tenant_id = ?
  `).get(id, tenantId) as { permission_level?: string | null } | undefined;
  if (!row) return null;
  const permissionLevel = row.permission_level ?? '';
  return isValidLevel(permissionLevel)
    ? permissionLevel
    : DEFAULT_SESSION_PERMISSION_LEVEL;
}

export function updateSessionPermissionLevel(
  id: string,
  permissionLevel: PermissionLevel,
  tenantId = 'default',
): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE sessions
    SET permission_level = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(permissionLevel, id, tenantId);
  return result.changes > 0;
}

export function updateSessionWorkspaceContext(
  id: string,
  tenantId = 'default',
  context: SessionWorkspaceContextInput,
): void {
  const db = getDb();
  const serialized = context.workspaceContext ? JSON.stringify(context.workspaceContext) : null;
  db.prepare(`
    UPDATE sessions
    SET workspace_root_id = ?, workspace_context = ?,
        execution_root_id = ?, execution_context = ?,
        project_root_id = CASE WHEN NOT EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.tenant_id = sessions.tenant_id AND c.session_id = sessions.id
        ) THEN ? ELSE project_root_id END,
        project_context = CASE WHEN NOT EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.tenant_id = sessions.tenant_id AND c.session_id = sessions.id
        ) THEN ? ELSE project_context END,
        updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(
    context.workspaceRootId ?? null,
    serialized,
    context.workspaceRootId ?? null,
    serialized,
    context.workspaceRootId ?? null,
    serialized,
    id,
    tenantId,
  );
}

/** Assign ownership when an unused draft is adopted for a project. Once the
 * conversation has messages the ownership columns are immutable. */
export function bindDraftSessionProject(
  id: string,
  tenantId = 'default',
  context: SessionWorkspaceContextInput,
): boolean {
  const db = getDb();
  const serialized = context.workspaceContext ? JSON.stringify(context.workspaceContext) : null;
  const result = db.prepare(`
    UPDATE sessions
    SET workspace_root_id = ?, workspace_context = ?,
        project_root_id = ?, project_context = ?,
        execution_root_id = ?, execution_context = ?, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.tenant_id = sessions.tenant_id AND c.session_id = sessions.id
      )
  `).run(
    context.workspaceRootId ?? null, serialized,
    context.workspaceRootId ?? null, serialized,
    context.workspaceRootId ?? null, serialized,
    id, tenantId,
  );
  return result.changes > 0;
}

/**
 * Archive a session (soft delete).
 */
export function archiveSession(id: string, tenantId = 'default'): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET archived = 1, updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
}

/** Find the newest unused New Chat draft for a user. */
export function getReusableDraftSession(userId: string, tenantId = 'default'): Session | null {
  const db = getDb();
  const row = db.prepare(`
    ${sessionSelect(`
      WHERE s.tenant_id = ?
        AND s.user_id = ?
        AND s.archived = 0
        AND s.title = 'New Chat'
        AND NOT EXISTS (
          SELECT 1
          FROM conversations c
          WHERE c.tenant_id = s.tenant_id AND c.session_id = s.id
          LIMIT 1
        )
    `)}
    ORDER BY s.updated_at DESC, s.rowid DESC
    LIMIT 1
  `).get(tenantId, userId) as Session | undefined;
  return row ? normalizeSession(row) : null;
}

/** Archive unused New Chat drafts, optionally keeping one current draft. */
export function archiveUnusedDraftSessions(userId: string, tenantId = 'default', keepSessionId?: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE sessions
    SET archived = 1, updated_at = datetime('now')
    WHERE tenant_id = ?
      AND user_id = ?
      AND archived = 0
      AND title = 'New Chat'
      ${keepSessionId ? 'AND id <> ?' : ''}
      AND NOT EXISTS (
        SELECT 1
        FROM conversations c
        WHERE c.tenant_id = sessions.tenant_id AND c.session_id = sessions.id
        LIMIT 1
      )
  `).run(...(keepSessionId ? [tenantId, userId, keepSessionId] : [tenantId, userId]));
  return Number(result.changes ?? 0);
}

/**
 * Delete a session permanently.
 */
export function deleteSession(id: string, tenantId = 'default'): void {
  const db = getDb();
  db.prepare(`
    DELETE FROM sessions WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
}

/**
 * Update a session's updated_at timestamp.
 */
export function touchSession(id: string, tenantId = 'default'): void {
  const db = getDb();
  db.prepare(`
    UPDATE sessions SET updated_at = datetime('now') WHERE id = ? AND tenant_id = ?
  `).run(id, tenantId);
}

/**
 * Get the most recent non-archived session for a user, or create a new one
 * if none exists or the most recent is older than 24 hours.
 * Returns SessionResult with staleSessionId when an old session was replaced.
 */
export function getOrCreateSessionForChat(
  chatId: string,
  userId: string,
  tenantId = 'default',
): SessionResult {
  const db = getDb();

  // Find the most recent non-archived session for this user
  const recent = db.prepare(`
    SELECT id, tenant_id, user_id, title, created_at, updated_at, archived
    FROM sessions
    WHERE tenant_id = ? AND user_id = ? AND archived = 0
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(tenantId, userId) as Session | undefined;

  if (recent) {
    const updatedAt = parseSessionTime(recent.updated_at);
    const now = Date.now();
    if (now - updatedAt < SESSION_STALE_MS) {
      return { session: normalizeSession(recent) };
    }
  }

  // Create a new session — old one was stale
  const newSession = createSession(userId, 'New Chat', tenantId);
  return { session: newSession, staleSessionId: recent?.id };
}
