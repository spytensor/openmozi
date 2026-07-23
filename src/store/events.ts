import { getDb } from './db.js';

export interface EventRecord {
  id: number;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: unknown;
  created_at: string;
}

/** Log an event to the event_log table */
export function log(
  eventType: string,
  entityType: string,
  entityId: string,
  payload: unknown,
  tenantId = 'default'
): { id: number } {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO event_log (tenant_id, event_type, entity_type, entity_id, payload, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  const result = stmt.run(tenantId, eventType, entityType, entityId, JSON.stringify(payload));
  return { id: Number(result.lastInsertRowid) };
}

/** Query events by entity type and entity ID */
export function query(
  entityType: string,
  entityId: string,
  tenantId = 'default'
): EventRecord[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, event_type, entity_type, entity_id, payload, created_at
    FROM event_log
    WHERE tenant_id = ? AND entity_type = ? AND entity_id = ?
    ORDER BY created_at ASC
  `).all(tenantId, entityType, entityId) as Array<{ id: number; event_type: string; entity_type: string; entity_id: string; payload: string; created_at: string }>;

  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload),
  }));
}

/** Query recent events by event type (descending by creation time). */
export function queryByEventType(
  eventType: string,
  tenantId = 'default',
  limit = 50,
): EventRecord[] {
  const cappedLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, event_type, entity_type, entity_id, payload, created_at
    FROM event_log
    WHERE tenant_id = ? AND event_type = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(tenantId, eventType, cappedLimit) as Array<{
    id: number;
    event_type: string;
    entity_type: string;
    entity_id: string;
    payload: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload),
  }));
}
