import { getDb } from '../store/db.js';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { buildCheckpointHardState, upsertRuntimeState } from '../core/hard-state-plane.js';

const logger = pino({ name: 'mozi:tel:checkpoint' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileChange {
  path: string;
  hash_before?: string | null;
  hash_after?: string | null;
  content_before?: string | null;
}

export interface Checkpoint {
  checkpoint_id: string;
  task_id: string;
  step_index: number;
  files_changed: FileChange[];
  db_mutations?: unknown;
  agent_context_summary?: string | null;
  rollback_commands?: string[] | null;
  created_at: string;
}

export interface CreateCheckpointOptions {
  db_mutations?: unknown;
  agent_context_summary?: string;
  rollback_commands?: string[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a checkpoint recording the current state of files.
 * Call this BEFORE performing write operations to capture the "before" state.
 */
export function create(
  taskId: string,
  stepIndex: number,
  files: Array<{ path: string }>,
  tenantId = 'default',
  options: CreateCheckpointOptions = {},
): Checkpoint {
  const checkpointId = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const filesChanged: FileChange[] = files.map((f) => {
    const existed = existsSync(f.path);
    let hashBefore: string | null = null;
    let contentBefore: string | null = null;

    if (existed) {
      const content = readFileSync(f.path, 'utf-8');
      hashBefore = createHash('sha256').update(content).digest('hex');
      contentBefore = content;
    }

    return {
      path: f.path,
      hash_before: hashBefore,
      content_before: contentBefore,
    };
  });

  const db = getDb();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO checkpoints (
        id,
        tenant_id,
        task_id,
        step_index,
        files_changed,
        db_mutations,
        agent_context_summary,
        rollback_commands,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      checkpointId,
      tenantId,
      taskId,
      stepIndex,
      JSON.stringify(filesChanged),
      options.db_mutations ? JSON.stringify(options.db_mutations) : null,
      options.agent_context_summary ?? null,
      options.rollback_commands ? JSON.stringify(options.rollback_commands) : null,
    );

    const checkpointState = buildCheckpointHardState({
      checkpoint_id: checkpointId,
      task_id: taskId,
      step_index: stepIndex,
      files: filesChanged,
      db_mutations: options.db_mutations,
      rollback_commands: options.rollback_commands ?? [],
    });
    upsertRuntimeState('checkpoint_state', 'checkpoint', checkpointId, checkpointState, tenantId);
  })();

  logger.info({ checkpoint_id: checkpointId, task_id: taskId, step_index: stepIndex, files: files.length }, 'Checkpoint created');

  return {
    checkpoint_id: checkpointId,
    task_id: taskId,
    step_index: stepIndex,
    files_changed: filesChanged,
    db_mutations: options.db_mutations,
    agent_context_summary: options.agent_context_summary ?? null,
    rollback_commands: options.rollback_commands ?? null,
    created_at: new Date().toISOString(),
  };
}

/**
 * Record the "after" state of files in an existing checkpoint.
 * Call this AFTER write operations.
 */
export function recordAfter(checkpointId: string, tenantId = 'default'): void {
  const db = getDb();
  db.transaction(() => {
    const row = db.prepare(`
      SELECT files_changed FROM checkpoints WHERE id = ? AND tenant_id = ?
    `).get(checkpointId, tenantId) as { files_changed: string } | undefined;

    if (!row) throw new Error(`Checkpoint not found: ${checkpointId}`);

    const files = JSON.parse(row.files_changed) as FileChange[];
    for (const f of files) {
      if (existsSync(f.path)) {
        const content = readFileSync(f.path, 'utf-8');
        f.hash_after = createHash('sha256').update(content).digest('hex');
      } else {
        f.hash_after = null;
      }
    }

    db.prepare(`
      UPDATE checkpoints SET files_changed = ? WHERE id = ? AND tenant_id = ?
    `).run(JSON.stringify(files), checkpointId, tenantId);

    const checkpointMeta = db.prepare(`
      SELECT task_id, step_index, db_mutations, rollback_commands, created_at
      FROM checkpoints
      WHERE id = ? AND tenant_id = ?
    `).get(checkpointId, tenantId) as {
      task_id: string;
      step_index: number;
      db_mutations: string | null;
      rollback_commands: string | null;
      created_at: string;
    } | undefined;

    if (!checkpointMeta) return;

    const checkpointState = buildCheckpointHardState({
      checkpoint_id: checkpointId,
      task_id: checkpointMeta.task_id,
      step_index: checkpointMeta.step_index,
      files,
      db_mutations: checkpointMeta.db_mutations ? JSON.parse(checkpointMeta.db_mutations) : null,
      rollback_commands: checkpointMeta.rollback_commands ? JSON.parse(checkpointMeta.rollback_commands) : [],
      created_at: checkpointMeta.created_at,
    });
    upsertRuntimeState('checkpoint_state', 'checkpoint', checkpointId, checkpointState, tenantId);
  })();
}

/**
 * Rollback files to their state at checkpoint creation.
 * Restores file contents from the checkpoint snapshot.
 */
export function rollback(checkpointId: string, tenantId = 'default'): { restored: number; deleted: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT files_changed FROM checkpoints WHERE id = ? AND tenant_id = ?
  `).get(checkpointId, tenantId) as { files_changed: string } | undefined;

  if (!row) throw new Error(`Checkpoint not found: ${checkpointId}`);

  const files = JSON.parse(row.files_changed) as FileChange[];
  let restored = 0;
  let deleted = 0;

  for (const f of files) {
    if (f.content_before !== null && f.content_before !== undefined) {
      // File existed before — restore its content
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, f.content_before, 'utf-8');
      restored++;
    } else {
      // File did not exist before — delete it if it was created
      if (existsSync(f.path)) {
        unlinkSync(f.path);
        deleted++;
      }
    }
  }

  logger.info({ checkpoint_id: checkpointId, restored, deleted }, 'Rollback completed');
  return { restored, deleted };
}

/** Get all checkpoints for a task, ordered by step index */
export function getForTask(taskId: string, tenantId = 'default'): Checkpoint[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, task_id, step_index, files_changed, db_mutations, agent_context_summary, rollback_commands, created_at
    FROM checkpoints
    WHERE task_id = ? AND tenant_id = ?
    ORDER BY step_index ASC
  `).all(taskId, tenantId) as Array<{
    id: string;
    task_id: string;
    step_index: number;
    files_changed: string;
    db_mutations: string | null;
    agent_context_summary: string | null;
    rollback_commands: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    checkpoint_id: row.id,
    task_id: row.task_id,
    step_index: row.step_index,
    files_changed: JSON.parse(row.files_changed),
    db_mutations: row.db_mutations ? JSON.parse(row.db_mutations) : null,
    agent_context_summary: row.agent_context_summary,
    rollback_commands: row.rollback_commands ? JSON.parse(row.rollback_commands) : null,
    created_at: row.created_at,
  }));
}
