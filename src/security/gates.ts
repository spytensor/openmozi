/**
 * Hard Gates — Human-in-the-loop approval for sensitive actions.
 *
 * Hard gate actions: skill_register, agent_promote, l3_grant, permission_elevation, external_comm, desktop_control.
 * When triggered, an approval request is created in SQLite and execution
 * blocks until /approve <id> or /reject <id>.
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { emit as emitProgress } from '../progress/event-bus.js';
import { settleApprovalDecision } from './approval-wait.js';
import { applySessionPermissionLevel } from './session-permissions.js';
import { isValidLevel } from './permissions.js';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

const logger = pino({ name: 'mozi:security:gates' });

// ---------------------------------------------------------------------------
// Hard gate action types
// ---------------------------------------------------------------------------

export const HARD_GATE_ACTIONS = [
  'skill_register',
  'agent_promote',
  'l3_grant',
  'permission_elevation',
  'external_comm',
  'desktop_control',
] as const;

export type HardGateAction = (typeof HARD_GATE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Table setup (migration-safe)
// ---------------------------------------------------------------------------

let tableEnsured = false;

function ensureTable(): void {
  if (tableEnsured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      action TEXT NOT NULL,
      description TEXT NOT NULL,
      context JSON,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      requested_by TEXT,
      resolved_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    );
  `);
  tableEnsured = true;
}

/** Reset the table-ensured flag (for tests) */
export function resetTableFlag(): void {
  tableEnsured = false;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  id: string;
  tenant_id: string;
  action: string;
  description: string;
  context: Record<string, unknown> | null;
  status: 'pending' | 'approved' | 'rejected';
  requested_by: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deserializeRequest(row: Record<string, unknown>): ApprovalRequest {
  return {
    id: row.id as string,
    tenant_id: row.tenant_id as string,
    action: row.action as string,
    description: row.description as string,
    context: row.context ? JSON.parse(row.context as string) : null,
    status: row.status as 'pending' | 'approved' | 'rejected',
    requested_by: (row.requested_by as string) ?? null,
    resolved_by: (row.resolved_by as string) ?? null,
    created_at: row.created_at as string,
    resolved_at: (row.resolved_at as string) ?? null,
  };
}

function stringFromContext(context: Record<string, unknown> | null, key: string): string | null {
  const value = context?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function emitApprovalResolved(request: ApprovalRequest): void {
  const requiredLevel = stringFromContext(request.context, 'required_level') ?? undefined;
  const grantScope = stringFromContext(request.context, 'grant_scope');
  const sessionFullAccess = request.status === 'approved' &&
    (request.action === 'permission_elevation' || request.action === 'write_confirmation') &&
    grantScope !== 'once';
  emitProgress({
    type: 'approval_resolved',
    approvalRequestId: request.id,
    approvalAction: request.action,
    approvalStatus: request.status === 'approved' ? 'approved' : 'rejected',
    description: request.description,
    tenantId: request.tenant_id,
    chatId: stringFromContext(request.context, 'chatId') ?? undefined,
    sessionId: stringFromContext(request.context, 'sessionId') ?? undefined,
    turnId: stringFromContext(request.context, 'turnId') ?? undefined,
    currentLevel: stringFromContext(request.context, 'current_level') ?? undefined,
    requiredLevel,
    permissionLevel: sessionFullAccess ? 'L3_FULL_ACCESS' : undefined,
    grantScope: grantScope === 'once' ? 'once' : grantScope === 'session' ? 'session' : undefined,
    deniedAction: stringFromContext(request.context, 'denied_action') ?? undefined,
    approvalTool: stringFromContext(request.context, 'tool') ?? undefined,
    toolIntent: stringFromContext(request.context, 'tool_intent') ?? undefined,
    originatingPrompt: stringFromContext(request.context, 'originating_prompt') ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if an action is a hard gate action.
 */
export function isHardGateAction(action: string): action is HardGateAction {
  return HARD_GATE_ACTIONS.includes(action as HardGateAction);
}

/**
 * Create an approval request for a hard gate action.
 *
 * @param action      - The hard gate action (e.g. 'skill_register')
 * @param description - Human-readable description of what needs approval
 * @param context     - Optional context data (agent_id, skill_id, etc.)
 * @param requestedBy - Who requested this (agent_id or 'system')
 * @param tenantId    - Tenant
 * @returns The created approval request
 */
export function createApprovalRequest(
  action: string,
  description: string,
  context?: Record<string, unknown>,
  requestedBy = 'system',
  tenantId = 'default',
): ApprovalRequest {
  ensureTable();
  const db = getDb();
  const id = randomUUID();

  db.prepare(`
    INSERT INTO approval_requests (id, tenant_id, action, description, context, requested_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, action, description, context ? JSON.stringify(context) : null, requestedBy);

  logEvent('approval_requested', 'gate', id, { action, description, requested_by: requestedBy }, tenantId);
  logger.info({ request_id: id, action, description }, 'Approval request created');

  const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as Record<string, unknown>;
  return deserializeRequest(row);
}

/**
 * Approve an approval request.
 *
 * @param requestId  - The request ID
 * @param resolvedBy - Who approved
 * @param tenantId   - Tenant
 * @returns The updated request
 * @throws Error if request not found or already resolved
 */
export function approveRequest(
  requestId: string,
  resolvedBy = 'user',
  tenantId = 'default',
  opts?: { grantScope?: 'once' | 'session' },
): ApprovalRequest {
  ensureTable();
  const db = getDb();

  const row = db.prepare(
    'SELECT * FROM approval_requests WHERE id = ? AND tenant_id = ?',
  ).get(requestId, tenantId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Approval request '${requestId}' not found`);
  }

  const request = deserializeRequest(row);

  if (request.status !== 'pending') {
    throw new Error(`Request '${requestId}' is already '${request.status}'`);
  }

  // Preserve legacy write confirmations with no scope as one-time. Permission
  // elevations historically meant a session upgrade, so retain that default.
  const grantScope = opts?.grantScope ?? (request.action === 'permission_elevation' ? 'session' : 'once');
  const elevation = (() => {
    if ((request.action !== 'permission_elevation' && request.action !== 'write_confirmation') || grantScope === 'once') return null;
    const sessionId = stringFromContext(request.context, 'sessionId');
    const requiredLevel = stringFromContext(request.context, 'required_level');
    if (!sessionId || (request.action === 'permission_elevation' && (!requiredLevel || !isValidLevel(requiredLevel)))) {
      throw new Error(`Permission elevation request '${requestId}' has invalid context`);
    }
    return { sessionId };
  })();

  const approveTx = db.transaction(() => {
    // Persist the user's decision. A one-time grant is consumed only by the
    // waiting tool call; a session grant upgrades the session to Full access.
    if (opts?.grantScope || request.action === 'permission_elevation') {
      const mergedContext = { ...(request.context ?? {}), grant_scope: opts?.grantScope ?? 'session' };
      db.prepare('UPDATE approval_requests SET context = ? WHERE id = ? AND tenant_id = ?')
        .run(JSON.stringify(mergedContext), requestId, tenantId);
    }

    db.prepare(`
      UPDATE approval_requests
      SET status = 'approved', resolved_at = datetime('now'), resolved_by = ?
      WHERE id = ? AND tenant_id = ?
    `).run(resolvedBy, requestId, tenantId);

    if (!elevation) return;
    const updated = applySessionPermissionLevel({
      sessionId: elevation.sessionId,
      tenantId,
      permissionLevel: 'L3_FULL_ACCESS',
      userId: resolvedBy,
      reason: 'permission_full_access_approved',
      details: {
        approval_request_id: requestId,
        current_level: stringFromContext(request.context, 'current_level'),
        denied_action: stringFromContext(request.context, 'denied_action'),
        tool: stringFromContext(request.context, 'tool'),
      },
    });
    if (!updated && request.action === 'permission_elevation') {
      throw new Error(`Session '${elevation.sessionId}' not found for permission elevation`);
    }
  });
  approveTx();
  settleApprovalDecision(requestId, 'approved');

  logEvent('approval_approved', 'gate', requestId, { action: request.action, resolved_by: resolvedBy }, tenantId);
  logger.info({ request_id: requestId, action: request.action }, 'Request approved');

  const updated = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId) as Record<string, unknown>;
  const updatedRequest = deserializeRequest(updated);
  emitApprovalResolved(updatedRequest);
  return updatedRequest;
}

/**
 * Reject an approval request.
 *
 * @param requestId  - The request ID
 * @param resolvedBy - Who rejected
 * @param tenantId   - Tenant
 * @returns The updated request
 * @throws Error if request not found or already resolved
 */
export function rejectRequest(requestId: string, resolvedBy = 'user', tenantId = 'default'): ApprovalRequest {
  ensureTable();
  const db = getDb();

  const row = db.prepare(
    'SELECT * FROM approval_requests WHERE id = ? AND tenant_id = ?',
  ).get(requestId, tenantId) as Record<string, unknown> | undefined;

  if (!row) {
    throw new Error(`Approval request '${requestId}' not found`);
  }

  const request = deserializeRequest(row);

  if (request.status !== 'pending') {
    throw new Error(`Request '${requestId}' is already '${request.status}'`);
  }

  db.prepare(`
    UPDATE approval_requests
    SET status = 'rejected', resolved_at = datetime('now'), resolved_by = ?
    WHERE id = ? AND tenant_id = ?
  `).run(resolvedBy, requestId, tenantId);
  settleApprovalDecision(requestId, 'rejected');

  logEvent('approval_rejected', 'gate', requestId, { action: request.action, resolved_by: resolvedBy }, tenantId);
  logger.info({ request_id: requestId, action: request.action }, 'Request rejected');

  const updated = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(requestId) as Record<string, unknown>;
  const updatedRequest = deserializeRequest(updated);
  emitApprovalResolved(updatedRequest);
  return updatedRequest;
}

/**
 * Get a specific approval request by ID.
 */
export function getRequest(requestId: string, tenantId = 'default'): ApprovalRequest | null {
  ensureTable();
  const db = getDb();

  const row = db.prepare(
    'SELECT * FROM approval_requests WHERE id = ? AND tenant_id = ?',
  ).get(requestId, tenantId) as Record<string, unknown> | undefined;

  if (!row) return null;
  return deserializeRequest(row);
}

/**
 * List pending approval requests.
 */
export function getPendingRequests(tenantId = 'default'): ApprovalRequest[] {
  ensureTable();
  const db = getDb();

  const rows = db.prepare(`
    SELECT * FROM approval_requests
    WHERE tenant_id = ? AND status = 'pending'
    ORDER BY created_at ASC
  `).all(tenantId) as Record<string, unknown>[];

  return rows.map(deserializeRequest);
}

/**
 * List all approval requests (optionally filtered by action or status).
 */
export function listRequests(
  filters: { action?: string; status?: string; tenant_id?: string } = {},
): ApprovalRequest[] {
  ensureTable();
  const db = getDb();
  const tenantId = filters.tenant_id ?? 'default';
  const conditions = ['tenant_id = ?'];
  const params: unknown[] = [tenantId];

  if (filters.action) {
    conditions.push('action = ?');
    params.push(filters.action);
  }
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  const rows = db.prepare(`
    SELECT * FROM approval_requests
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
  `).all(...params) as Record<string, unknown>[];

  return rows.map(deserializeRequest);
}

/**
 * Format an approval notification message (for Telegram or WebSocket).
 */
export function formatApprovalNotification(request: ApprovalRequest): string {
  return `[APPROVAL NEEDED] ${request.description}\nAction: ${request.action}\nID: ${request.id}\nUse /approve ${request.id} or /reject ${request.id}`;
}
