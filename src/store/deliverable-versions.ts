import { randomBytes } from 'node:crypto';
import { constants, copyFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { extname, join } from 'node:path';
import { getDeliverableVersionsDir } from '../paths.js';
import { getDb } from './db.js';
import { deliverableRegistry } from './deliverables.js';

interface DeliverableVersionRecord {
  id: string;
  deliverableId: string;
  tenantId: string;
  version: number;
  snapshotPath: string;
  size: number;
  hash: string | null;
  sessionId: string | null;
  createdAt: string;
}

interface DeliverableVersionRow {
  id: string;
  deliverable_id: string;
  tenant_id: string;
  version: number;
  snapshot_path: string;
  size: number;
  hash: string | null;
  session_id: string | null;
  created_at: string;
}

interface SnapshotInput {
  tenantId: string;
  deliverableId: string;
  version: number;
  sourcePath: string;
  hash: string | null;
  sessionId?: string;
}

function fromRow(row: DeliverableVersionRow): DeliverableVersionRecord {
  return {
    id: row.id,
    deliverableId: row.deliverable_id,
    tenantId: row.tenant_id,
    version: row.version,
    snapshotPath: row.snapshot_path,
    size: row.size,
    hash: row.hash,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

function getByVersion(
  tenantId: string,
  deliverableId: string,
  version: number,
): DeliverableVersionRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM deliverable_versions
    WHERE tenant_id = ? AND deliverable_id = ? AND version = ?
  `).get(tenantId, deliverableId, version) as DeliverableVersionRow | undefined;
  return row ? fromRow(row) : null;
}

function listByDeliverable(tenantId: string, deliverableId: string): DeliverableVersionRecord[] {
  const rows = getDb().prepare(`
    SELECT * FROM deliverable_versions
    WHERE tenant_id = ? AND deliverable_id = ?
    ORDER BY version DESC
  `).all(tenantId, deliverableId) as DeliverableVersionRow[];
  return rows.map(fromRow);
}

/**
 * Copy the current deliverable bytes into the server-owned version directory,
 * then record the immutable snapshot and advance the registry count.
 */
function snapshot(input: SnapshotInput): DeliverableVersionRecord {
  const deliverable = deliverableRegistry.getById(input.tenantId, input.deliverableId);
  if (!deliverable) throw new Error('Deliverable not found');
  if (input.sourcePath !== deliverable.path) throw new Error('Snapshot source does not match deliverable path');
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error('Invalid deliverable version');
  if (getByVersion(input.tenantId, input.deliverableId, input.version)) {
    throw new Error(`Deliverable version ${input.version} already exists`);
  }

  const snapshotDir = getDeliverableVersionsDir(input.deliverableId);
  const snapshotPath = join(snapshotDir, `v${input.version}${extname(deliverable.path)}`);
  mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
  copyFileSync(input.sourcePath, snapshotPath, constants.COPYFILE_EXCL);

  const id = `dlvv_${randomBytes(8).toString('hex')}`;
  const size = statSync(snapshotPath).size;
  const createdAt = new Date().toISOString();
  try {
    getDb().transaction(() => {
      getDb().prepare(`
        INSERT INTO deliverable_versions (
          id, deliverable_id, tenant_id, version, snapshot_path,
          size, hash, session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.deliverableId,
        input.tenantId,
        input.version,
        snapshotPath,
        size,
        input.hash,
        input.sessionId ?? null,
        createdAt,
      );
      getDb().prepare(`
        UPDATE deliverables
        SET version_count = ?
        WHERE tenant_id = ? AND id = ?
      `).run(input.version, input.tenantId, input.deliverableId);
    })();
  } catch (error) {
    try {
      unlinkSync(snapshotPath);
    } catch {
      // Best effort: the database remains authoritative if cleanup also fails.
    }
    throw error;
  }

  return getByVersion(input.tenantId, input.deliverableId, input.version)!;
}

/** Tenant-scoped immutable deliverable version persistence. */
export const deliverableVersionStore = {
  snapshot,
  getByVersion,
  listByDeliverable,
};
