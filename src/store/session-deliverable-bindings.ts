import { getDb } from './db.js';

interface SessionDeliverableBinding {
  sessionId: string;
  deliverableId: string;
  tenantId: string;
  createdAt: string;
}

interface BoundDeliverable {
  deliverableId: string;
  path: string;
  title: string;
  version: number;
  createdAt: string;
}

interface SessionDeliverableBindingRow {
  session_id: string;
  deliverable_id: string;
  tenant_id: string;
  created_at: string;
}

interface BoundDeliverableRow {
  deliverable_id: string;
  path: string;
  title: string;
  version: number;
  created_at: string;
}

function fromRow(row: SessionDeliverableBindingRow): SessionDeliverableBinding {
  return {
    sessionId: row.session_id,
    deliverableId: row.deliverable_id,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
  };
}

function create(input: {
  sessionId: string;
  deliverableId: string;
  tenantId: string;
  createdAt?: string;
}): SessionDeliverableBinding {
  const createdAt = input.createdAt ?? new Date().toISOString();
  getDb().prepare(`
    INSERT INTO session_deliverable_bindings (
      session_id, deliverable_id, tenant_id, created_at
    ) VALUES (?, ?, ?, ?)
  `).run(input.sessionId, input.deliverableId, input.tenantId, createdAt);
  return get(input.tenantId, input.sessionId, input.deliverableId)!;
}

function get(
  tenantId: string,
  sessionId: string,
  deliverableId: string,
): SessionDeliverableBinding | null {
  const row = getDb().prepare(`
    SELECT * FROM session_deliverable_bindings
    WHERE tenant_id = ? AND session_id = ? AND deliverable_id = ?
  `).get(tenantId, sessionId, deliverableId) as SessionDeliverableBindingRow | undefined;
  return row ? fromRow(row) : null;
}

function listBySession(tenantId: string, sessionId: string): SessionDeliverableBinding[] {
  const rows = getDb().prepare(`
    SELECT * FROM session_deliverable_bindings
    WHERE tenant_id = ? AND session_id = ?
    ORDER BY created_at DESC, deliverable_id ASC
  `).all(tenantId, sessionId) as SessionDeliverableBindingRow[];
  return rows.map(fromRow);
}

function updateCreatedAt(
  tenantId: string,
  sessionId: string,
  deliverableId: string,
  createdAt: string,
): SessionDeliverableBinding | null {
  getDb().prepare(`
    UPDATE session_deliverable_bindings SET created_at = ?
    WHERE tenant_id = ? AND session_id = ? AND deliverable_id = ?
  `).run(createdAt, tenantId, sessionId, deliverableId);
  return get(tenantId, sessionId, deliverableId);
}

function remove(tenantId: string, sessionId: string, deliverableId: string): boolean {
  return getDb().prepare(`
    DELETE FROM session_deliverable_bindings
    WHERE tenant_id = ? AND session_id = ? AND deliverable_id = ?
  `).run(tenantId, sessionId, deliverableId).changes > 0;
}

/**
 * Resolve bindings only when the bound session still belongs to the requested
 * user and both the session and deliverable share the binding's tenant.
 */
function listDeliverablesForSession(input: {
  tenantId: string;
  userId: string;
  sessionId: string;
}): BoundDeliverable[] {
  const rows = getDb().prepare(`
    SELECT binding.deliverable_id, deliverable.path, deliverable.title,
           deliverable.version_count AS version, binding.created_at
    FROM session_deliverable_bindings AS binding
    INNER JOIN sessions AS session
      ON session.tenant_id = binding.tenant_id
     AND session.id = binding.session_id
    INNER JOIN deliverables AS deliverable
      ON deliverable.tenant_id = binding.tenant_id
     AND deliverable.id = binding.deliverable_id
    WHERE binding.tenant_id = ?
      AND binding.session_id = ?
      AND session.user_id = ?
    ORDER BY binding.created_at DESC, binding.deliverable_id ASC
  `).all(input.tenantId, input.sessionId, input.userId) as BoundDeliverableRow[];
  return rows.map((row) => ({
    deliverableId: row.deliverable_id,
    path: row.path,
    title: row.title,
    version: row.version,
    createdAt: row.created_at,
  }));
}

/** Tenant-scoped session-to-deliverable binding persistence. */
export const sessionDeliverableBindingStore = {
  create,
  get,
  listBySession,
  updateCreatedAt,
  remove,
  listDeliverablesForSession,
};
