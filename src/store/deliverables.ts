import { randomBytes } from 'node:crypto';
import { getDb } from './db.js';

interface DeliverableRecord {
  id: string;
  tenantId: string;
  path: string;
  kind: string;
  title: string;
  currentSize: number;
  currentMtimeMs: number;
  currentHash: string | null;
  versionCount: number;
  firstSessionId: string | null;
  lastSessionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeliverableSearchResult {
  deliverableId: string;
  title: string;
  path: string;
  kind: string;
  version: number;
  updatedAt: string;
  sessionTitle: string | null;
}

interface DeliverableRow {
  id: string;
  tenant_id: string;
  path: string;
  kind: string;
  title: string;
  current_size: number;
  current_mtime_ms: number;
  current_hash: string | null;
  version_count: number;
  first_session_id: string | null;
  last_session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface UpsertDeliverableInput {
  tenantId: string;
  path: string;
  kind: string;
  title: string;
  currentSize: number;
  currentMtimeMs: number;
  currentHash: string | null;
  sessionId?: string;
  initialVersionCount?: number;
}

interface DeliverableSearchRow {
  id: string;
  title: string;
  path: string;
  kind: string;
  version_count: number;
  updated_at: string;
  session_title: string | null;
}

function fromRow(row: DeliverableRow): DeliverableRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    path: row.path,
    kind: row.kind,
    title: row.title,
    currentSize: row.current_size,
    currentMtimeMs: row.current_mtime_ms,
    currentHash: row.current_hash,
    versionCount: row.version_count,
    firstSessionId: row.first_session_id,
    lastSessionId: row.last_session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getById(tenantId: string, id: string): DeliverableRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM deliverables WHERE tenant_id = ? AND id = ?
  `).get(tenantId, id) as DeliverableRow | undefined;
  return row ? fromRow(row) : null;
}

function getByPath(tenantId: string, path: string): DeliverableRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM deliverables WHERE tenant_id = ? AND path = ?
  `).get(tenantId, path) as DeliverableRow | undefined;
  return row ? fromRow(row) : null;
}

function listByTenant(tenantId: string): DeliverableRecord[] {
  const rows = getDb().prepare(`
    SELECT * FROM deliverables WHERE tenant_id = ? ORDER BY updated_at DESC, id ASC
  `).all(tenantId) as DeliverableRow[];
  return rows.map(fromRow);
}

function search(tenantId: string, query: string, limit = 10): DeliverableSearchResult[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const boundedLimit = Math.min(10, Math.max(1, Math.floor(limit)));
  const pattern = `%${normalized}%`;
  const rows = getDb().prepare(`
    SELECT deliverable.id, deliverable.title, deliverable.path, deliverable.kind,
           deliverable.version_count, deliverable.updated_at,
           session.title AS session_title
    FROM deliverables AS deliverable
    LEFT JOIN sessions AS session
      ON session.tenant_id = deliverable.tenant_id
     AND session.id = deliverable.last_session_id
    WHERE deliverable.tenant_id = ?
      AND (deliverable.title LIKE ? OR deliverable.path LIKE ?)
    ORDER BY deliverable.updated_at DESC
    LIMIT ?
  `).all(tenantId, pattern, pattern, boundedLimit) as DeliverableSearchRow[];
  return rows.map((row) => ({
    deliverableId: row.id,
    title: row.title,
    path: row.path,
    kind: row.kind,
    version: row.version_count,
    updatedAt: row.updated_at,
    sessionTitle: row.session_title,
  }));
}

function upsertByPath(input: UpsertDeliverableInput): DeliverableRecord {
  const existing = getByPath(input.tenantId, input.path);
  if (existing) {
    const changed = existing.currentSize !== input.currentSize
      || existing.currentMtimeMs !== input.currentMtimeMs;
    if (!changed) return existing;

    const updatedAt = new Date().toISOString();
    getDb().prepare(`
      UPDATE deliverables
      SET current_size = ?, current_mtime_ms = ?, current_hash = ?,
          last_session_id = ?, updated_at = ?
      WHERE tenant_id = ? AND path = ?
    `).run(
      input.currentSize,
      input.currentMtimeMs,
      input.currentHash,
      input.sessionId ?? existing.lastSessionId,
      updatedAt,
      input.tenantId,
      input.path,
    );
    return getByPath(input.tenantId, input.path)!;
  }

  const id = `dlv_${randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO deliverables (
      id, tenant_id, path, kind, title,
      current_size, current_mtime_ms, current_hash, version_count,
      first_session_id, last_session_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.tenantId,
    input.path,
    input.kind,
    input.title,
    input.currentSize,
    input.currentMtimeMs,
    input.currentHash,
    input.initialVersionCount ?? 1,
    input.sessionId ?? null,
    input.sessionId ?? null,
    now,
    now,
  );
  return getById(input.tenantId, id)!;
}

/** Tenant-scoped deliverable registry CRUD. */
export const deliverableRegistry = {
  upsertByPath,
  getById,
  getByPath,
  listByTenant,
  search,
};
