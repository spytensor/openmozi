/**
 * Crash Recovery — Event-sourcing based state recovery after unclean shutdown.
 *
 * On startup, checks if the previous session ended cleanly. If not, replays
 * the event log to reconstruct task states, handles orphaned running tasks
 * (retrying from checkpoints or marking as failed), and generates a recovery
 * report for the user.
 *
 * Uses a `system_state` table row to track clean_shutdown flag.
 */

import { getDb } from '../store/db.js';
import { log as logEvent } from '../store/events.js';
import { CheckpointHardStateSchema, getRuntimeState } from './hard-state-plane.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:crash-recovery' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryReport {
  /** Whether recovery was needed */
  recovered: boolean;
  /** Previous shutdown was clean */
  wasCleanShutdown: boolean;
  /** Tasks that were running and had checkpoints — marked ready for retry */
  tasksResumed: string[];
  /** Checkpoint metadata for resumed tasks (for deterministic replay/audit) */
  checkpointResumes: Array<{
    taskId: string;
    checkpointId: string;
    stepIndex: number;
    filesChanged: number;
    createdAt: string;
  }>;
  /** Tasks that were running but had no checkpoint — marked failed */
  tasksFailed: string[];
  /** SubAgents that were active — marked as crashed */
  agentsCrashed: string[];
  /** Human-readable summary */
  summary: string;
}

// ---------------------------------------------------------------------------
// System state table (migration-safe)
// ---------------------------------------------------------------------------

function ensureSystemStateTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

let tableEnsured = false;

function ensureTable(): void {
  if (!tableEnsured) {
    ensureSystemStateTable();
    tableEnsured = true;
  }
}

/** Reset the table-ensured flag (for testing) */
export function resetTableEnsured(): void {
  tableEnsured = false;
}

// ---------------------------------------------------------------------------
// Clean shutdown flag
// ---------------------------------------------------------------------------

/**
 * Set the clean_shutdown flag. Call on graceful exit.
 */
export function setCleanShutdown(clean: boolean): void {
  ensureTable();
  const db = getDb();
  db.prepare(`
    INSERT INTO system_state (key, value, updated_at)
    VALUES ('clean_shutdown', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
  `).run(clean ? '1' : '0', clean ? '1' : '0');
}

/**
 * Check if previous shutdown was clean. Returns true if no record exists
 * (first run) or if the flag is set to '1'.
 */
export function wasCleanShutdown(): boolean {
  ensureTable();
  const db = getDb();
  const row = db.prepare(
    "SELECT value FROM system_state WHERE key = 'clean_shutdown'"
  ).get() as { value: string } | undefined;

  if (!row) return true; // First run — no crash
  return row.value === '1';
}

// ---------------------------------------------------------------------------
// Recovery logic
// ---------------------------------------------------------------------------

/**
 * Perform crash recovery on startup.
 *
 * 1. Check if previous session ended cleanly
 * 2. If unclean: replay event_log to find orphaned tasks
 * 3. Tasks with status "running" → check for checkpoints
 *    - Has checkpoint → mark as "ready" for retry
 *    - No checkpoint → mark as "failed"
 * 4. SubAgents that were active → mark as crashed
 * 5. Generate recovery report
 * 6. Clear clean_shutdown flag (will be set again on graceful exit)
 */
export function recover(tenantId = 'default'): RecoveryReport {
  ensureTable();
  const db = getDb();

  const clean = wasCleanShutdown();

  // Mark as unclean (will be set back to clean on graceful exit)
  setCleanShutdown(false);

  if (clean) {
    logger.info('Previous shutdown was clean — no recovery needed');
    return {
      recovered: false,
      wasCleanShutdown: true,
      tasksResumed: [],
      checkpointResumes: [],
      tasksFailed: [],
      agentsCrashed: [],
      summary: 'No recovery needed — previous shutdown was clean.',
    };
  }

  logger.warn('Unclean shutdown detected — starting recovery');

  const tasksResumed: string[] = [];
  const checkpointResumes: RecoveryReport['checkpointResumes'] = [];
  const tasksFailed: string[] = [];
  const agentsCrashed: string[] = [];

  // Find tasks that were "running" or "assigned" at crash time
  const runningTasks = db.prepare(`
    SELECT id, title FROM tasks
    WHERE tenant_id = ? AND status IN ('running', 'assigned')
  `).all(tenantId) as Array<{ id: string; title: string }>;

  for (const task of runningTasks) {
    // Check for checkpoints
    const checkpoint = db.prepare(`
      SELECT id, step_index, files_changed, created_at FROM checkpoints
      WHERE task_id = ? AND tenant_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(task.id, tenantId) as {
      id: string;
      step_index: number;
      files_changed: string | null;
      created_at: string;
    } | undefined;

    if (checkpoint) {
      const checkpointState = getRuntimeState(
        'checkpoint_state',
        'checkpoint',
        checkpoint.id,
        CheckpointHardStateSchema,
        tenantId,
      );
      let filesChanged = 0;
      if (checkpointState) {
        filesChanged = checkpointState.files.length;
      } else {
        try {
          const parsed = checkpoint.files_changed ? JSON.parse(checkpoint.files_changed) : [];
          filesChanged = Array.isArray(parsed) ? parsed.length : 0;
        } catch {
          filesChanged = 0;
        }
      }

      const checkpointRef = {
        taskId: task.id,
        checkpointId: checkpoint.id,
        stepIndex: checkpointState?.step_index ?? checkpoint.step_index,
        filesChanged,
        createdAt: checkpointState?.created_at ?? checkpoint.created_at,
      };

      // Has checkpoint — mark as ready for retry
      db.prepare(`
        UPDATE tasks SET status = 'ready', updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `).run(task.id, tenantId);
      tasksResumed.push(task.id);
      checkpointResumes.push(checkpointRef);
      logEvent('task_recovered', 'task', task.id, {
        action: 'resumed_from_checkpoint',
        checkpoint: checkpointRef,
      }, tenantId);
      logger.info({ task_id: task.id, title: task.title }, 'Task resumed from checkpoint');
    } else {
      // No checkpoint — mark as failed
      db.prepare(`
        UPDATE tasks SET status = 'failed', updated_at = datetime('now')
        WHERE id = ? AND tenant_id = ?
      `).run(task.id, tenantId);
      tasksFailed.push(task.id);
      logEvent('task_recovered', 'task', task.id, {
        action: 'marked_failed_no_checkpoint',
      }, tenantId);
      logger.info({ task_id: task.id, title: task.title }, 'Task marked failed (no checkpoint)');
    }
  }

  // Find active agents and mark them as crashed (processes are dead after restart)
  const activeAgents = db.prepare(`
    SELECT id, name FROM agent_registry
    WHERE tenant_id = ? AND status = 'active'
  `).all(tenantId) as Array<{ id: string; name: string }>;

  for (const agent of activeAgents) {
    // Mark agent as inactive (process is dead)
    db.prepare(`
      UPDATE agent_registry SET status = 'inactive', updated_at = datetime('now')
      WHERE id = ? AND tenant_id = ?
    `).run(agent.id, tenantId);
    agentsCrashed.push(agent.id);
    logEvent('agent_crashed', 'agent', agent.id, {
      action: 'marked_inactive_after_crash',
    }, tenantId);
    logger.info({ agent_id: agent.id, name: agent.name }, 'Agent marked as crashed');
  }

  // Generate summary
  const parts: string[] = [];
  if (tasksResumed.length > 0) {
    parts.push(`${tasksResumed.length} task(s) resumed from checkpoint`);
  }
  if (tasksFailed.length > 0) {
    parts.push(`${tasksFailed.length} task(s) marked as failed`);
  }
  if (agentsCrashed.length > 0) {
    parts.push(`${agentsCrashed.length} agent(s) marked as crashed`);
  }

  const summary = parts.length > 0
    ? `[SYSTEM] Recovered from crash. ${parts.join(', ')}.`
    : '[SYSTEM] Recovered from crash. No orphaned tasks or agents found.';

  logEvent('system_recovery', 'system', 'recovery', {
    tasksResumed,
    checkpointResumes,
    tasksFailed,
    agentsCrashed,
    summary,
  }, tenantId);

  logger.info({ tasksResumed, checkpointResumes, tasksFailed, agentsCrashed }, 'Recovery complete');

  return {
    recovered: true,
    wasCleanShutdown: false,
    tasksResumed,
    checkpointResumes,
    tasksFailed,
    agentsCrashed,
    summary,
  };
}

/**
 * Format recovery report as a user-facing message.
 */
export function formatRecoveryMessage(report: RecoveryReport): string {
  if (!report.recovered) return '';
  return report.summary;
}
