import { getDb } from './db.js';
import pino from 'pino';

const logger = pino({ name: 'retention' });

/** Table name → timestamp column mapping */
const TABLE_TIMESTAMP_COLUMN: Record<string, string> = {
  event_log: 'created_at',
  turn_traces: 'started_at',
  tool_spans: 'started_at',
  alert_history: 'created_at',
  prompt_snapshots: 'captured_at',
  conversations: 'created_at',
  reminders: 'created_at',
  background_tasks: 'created_at',
  cron_task_runs: 'created_at',
};

const TABLE_TERMINAL_PREDICATE: Partial<Record<string, string>> = {
  reminders: "status IN ('delivered', 'failed')",
  background_tasks: "status IN ('completed', 'failed') AND delivery_status IN ('delivered', 'failed', 'none')",
  cron_task_runs: "status IN ('completed', 'failed')",
};

/** Allowed table names for pruning (prevents SQL injection via overrides) */
const ALLOWED_TABLES = new Set(Object.keys(TABLE_TIMESTAMP_COLUMN));

/** Default retention periods in days */
const DEFAULT_RETENTION: Record<string, number> = {
  event_log: 90,
  turn_traces: 90,
  tool_spans: 90,
  alert_history: 90,
  prompt_snapshots: 90,
  conversations: 365,
  reminders: 90,
  background_tasks: 90,
  cron_task_runs: 180,
};

/**
 * Prunes stale data from the database based on retention policies.
 * Each table's records older than the configured retention period are deleted.
 * Runs incremental vacuum after pruning to reclaim disk space.
 */
export function pruneStaleData(
  overrides?: Partial<Record<string, number>>,
): { deleted: Record<string, number> } {
  const db = getDb();
  const retention = { ...DEFAULT_RETENTION, ...overrides };
  const deleted: Record<string, number> = {};

  for (const [table, days] of Object.entries(retention)) {
    if (!ALLOWED_TABLES.has(table)) continue;
    if (days === undefined) continue;
    const tsCol = TABLE_TIMESTAMP_COLUMN[table];
    try {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      const terminal = TABLE_TERMINAL_PREDICATE[table];
      const result = db.prepare(`DELETE FROM "${table}" WHERE "${tsCol}" < ?${terminal ? ` AND ${terminal}` : ''}`).run(cutoff);
      deleted[table] = result.changes;
      if (result.changes > 0) {
        logger.info({ table, deleted: result.changes, cutoff_days: days }, 'Pruned stale records');
      }
    } catch (err) {
      // Table may not exist yet — skip gracefully
      logger.warn({ table, err: err instanceof Error ? err.message : String(err) }, 'Retention prune skipped');
    }
  }

  // Reclaim disk space
  try {
    db.pragma('incremental_vacuum(1000)');
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Incremental vacuum failed');
  }

  return { deleted };
}
