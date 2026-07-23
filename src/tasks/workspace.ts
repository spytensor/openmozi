/**
 * Task Workspace Persistence — file-based result/transcript storage.
 *
 * Enables task results and execution transcripts to survive context compaction.
 * Results are written to disk; only lightweight file-path references remain in
 * the conversation context after compaction.
 *
 * Directory layout:
 *   ~/.mozi/workspace/tasks/{task_id}/
 *     result.json        — final result envelope
 *     transcript.jsonl    — append-only execution log
 *     metadata.json       — task metadata snapshot
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import pino from 'pino';
import { getConfig } from '../config/index.js';

const logger = pino({ name: 'mozi:task-workspace' });

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the workspace root directory from config, expanding ~ to home.
 */
function resolveWorkspaceRoot(): string {
  try {
    const dir = getConfig().workspace.dir;
    if (dir.startsWith('~/') || dir === '~') {
      return resolve(homedir(), dir.slice(2) || '.');
    }
    return resolve(dir);
  } catch {
    // Config not loaded yet (e.g. in tests) — use default
    return resolve(homedir(), '.mozi/workspace');
  }
}

/** Base directory for all task workspaces. */
function getTasksBaseDir(): string {
  return join(resolveWorkspaceRoot(), 'tasks');
}

/** Directory for a specific task's workspace. */
export function getTaskWorkspacePath(taskId: string): string {
  // Sanitize taskId to prevent path traversal
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getTasksBaseDir(), safeId);
}

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure a task workspace directory exists.
 * Creates it (recursively) if it doesn't already exist.
 */
export function ensureTaskWorkspace(taskId: string): string {
  const dir = getTaskWorkspacePath(taskId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    logger.debug({ taskId, dir }, 'Created task workspace');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Result persistence
// ---------------------------------------------------------------------------

export interface PersistedTaskResult {
  task_id: string;
  success: boolean;
  output: string;
  tokens_used: number;
  elapsed_ms: number;
  completed_at: string;
  cancelled?: boolean;
  /** Agent that executed the task */
  agent_id?: string;
  /** Extra metadata from execution */
  metadata?: Record<string, unknown>;
}

/**
 * Persist a task's final result to disk.
 * Overwrites any previous result for the same task.
 */
export function persistTaskResult(taskId: string, result: PersistedTaskResult): string {
  const dir = ensureTaskWorkspace(taskId);
  const filePath = join(dir, 'result.json');
  writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
  logger.debug({ taskId, filePath, success: result.success }, 'Persisted task result');
  return filePath;
}

/**
 * Load a task's persisted result from disk.
 * Returns null if no result file exists.
 */
export function loadTaskResult(taskId: string): PersistedTaskResult | null {
  const filePath = join(getTaskWorkspacePath(taskId), 'result.json');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as PersistedTaskResult;
  } catch (err) {
    logger.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to load task result');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transcript persistence (append-only JSONL)
// ---------------------------------------------------------------------------

export interface TranscriptEntry {
  timestamp: string;
  type: 'llm_call' | 'tool_call' | 'tool_result' | 'system' | 'error' | 'summary';
  data: Record<string, unknown>;
}

/**
 * Append an entry to the task's execution transcript.
 * Creates the transcript file if it doesn't exist.
 */
export function appendTranscript(taskId: string, entry: TranscriptEntry): void {
  const dir = ensureTaskWorkspace(taskId);
  const filePath = join(dir, 'transcript.jsonl');
  appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Append multiple entries to the task's execution transcript in one I/O.
 */
export function appendTranscriptBatch(taskId: string, entries: TranscriptEntry[]): void {
  if (entries.length === 0) return;
  const dir = ensureTaskWorkspace(taskId);
  const filePath = join(dir, 'transcript.jsonl');
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(filePath, lines, 'utf-8');
}

/**
 * Load the full transcript for a task.
 * Returns an empty array if no transcript exists.
 */
export function loadTaskTranscript(taskId: string): TranscriptEntry[] {
  const filePath = join(getTaskWorkspacePath(taskId), 'transcript.jsonl');
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').map(line => JSON.parse(line) as TranscriptEntry);
  } catch (err) {
    logger.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Failed to load transcript');
    return [];
  }
}

/**
 * Load the last N entries of a task's transcript.
 * Efficient for large transcripts — reads from the end.
 */
export function loadTranscriptTail(taskId: string, count: number): TranscriptEntry[] {
  const entries = loadTaskTranscript(taskId);
  return entries.slice(-count);
}

/**
 * Get transcript summary: entry count and byte size.
 */
export function getTranscriptStats(taskId: string): { entries: number; bytes: number } | null {
  const filePath = join(getTaskWorkspacePath(taskId), 'transcript.jsonl');
  if (!existsSync(filePath)) return null;
  try {
    const stat = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8').trim();
    const entries = content ? content.split('\n').length : 0;
    return { entries, bytes: stat.size };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Metadata persistence
// ---------------------------------------------------------------------------

export interface TaskMetadataSnapshot {
  task_id: string;
  title: string;
  objective: string;
  status: string;
  agent_id?: string;
  created_at: string;
  workspace_path: string;
  /** Plan-root extras (decompose_task grouping node) — used for detached
   *  execution delivery targeting and boot-time resume. */
  chat_id?: string;
  channel_type?: string;
  session_id?: string;
  user_id?: string;
  permission_level?: string;
  plan_goal?: string;
  /** Foreground turn and exact user-authored request that admitted this plan.
   *  Immutable acceptance truth; the planner-authored goal is presentation. */
  source_turn_id?: string;
  source_request?: string;
  /** System prompt captured at plan creation so resumed subtask LLM calls
   *  run with the same instructions as the original turn. */
  system_prompt?: string;
  /** Immutable model selected by the turn that created this detached plan. */
  execution_model?: import('../core/execution-model.js').ExecutionModelSnapshot;
  /** Presentation locale resolved at plan admission (Issue #628/#735) so the
   *  background turn envelope — and every card label — follows the plan's
   *  language on resume, not the UI language or the completion text's. */
  plan_locale?: string;
  /** Who owns the final user-facing delivery for this plan. */
  plan_delivery_mode?: 'direct' | 'caller';
  /** Runtime origin for the plan turn (background for user plans, scheduler for scheduled runs). */
  plan_turn_origin?: import('../core/turn-envelope.js').TurnOrigin;
}

/**
 * Persist a task metadata snapshot for reference after compaction.
 */
export function persistTaskMetadata(taskId: string, metadata: TaskMetadataSnapshot): void {
  const dir = ensureTaskWorkspace(taskId);
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
}

/**
 * Load a task's metadata snapshot.
 */
export function loadTaskMetadata(taskId: string): TaskMetadataSnapshot | null {
  const filePath = join(getTaskWorkspacePath(taskId), 'metadata.json');
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as TaskMetadataSnapshot;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/**
 * Remove a task's workspace directory entirely.
 */
export function cleanupTaskWorkspace(taskId: string): void {
  const dir = getTaskWorkspacePath(taskId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    logger.debug({ taskId, dir }, 'Cleaned up task workspace');
  }
}

/**
 * Remove task workspaces older than the given retention period (in hours).
 * Scans the tasks base directory and removes stale entries.
 */
export function cleanupStaleWorkspaces(retentionHours: number): number {
  const baseDir = getTasksBaseDir();
  if (!existsSync(baseDir)) return 0;

  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  let removed = 0;

  try {
    for (const entry of readdirSync(baseDir)) {
      const taskDir = join(baseDir, entry);
      try {
        const stat = statSync(taskDir);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          rmSync(taskDir, { recursive: true, force: true });
          removed++;
        }
      } catch {
        // Skip entries that can't be stat'd
      }
    }
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to clean stale workspaces');
  }

  if (removed > 0) {
    logger.info({ removed, retentionHours }, 'Cleaned up stale task workspaces');
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Compaction-friendly reference marker
// ---------------------------------------------------------------------------

/** Prefix used to identify task workspace references in compressed context. */
export const TASK_RESULT_REF_PREFIX = '[TaskResult:';

/**
 * Build a compact reference string for embedding in compressed context.
 * Brain can use `read_task_result` tool to recover the full content.
 */
export function buildTaskResultRef(taskId: string, summary?: string): string {
  const wsPath = getTaskWorkspacePath(taskId);
  const summaryPart = summary ? ` — ${summary.slice(0, 120)}` : '';
  return `${TASK_RESULT_REF_PREFIX}${taskId}] path=${wsPath}/result.json${summaryPart}`;
}

/**
 * Check if a string contains a task result reference marker.
 */
export function containsTaskResultRef(text: string): boolean {
  return text.includes(TASK_RESULT_REF_PREFIX);
}

/**
 * Extract task IDs from task result reference markers in text.
 */
export function extractTaskIdsFromRefs(text: string): string[] {
  const ids: string[] = [];
  const regex = /\[TaskResult:([^\]]+)\]/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}
