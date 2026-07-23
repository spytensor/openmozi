import { getDb } from '../store/db.js';
import { hanTokenLength, isHanToken, tokenizeText } from './text-tokenizer.js';

const LESSON_COLUMNS = 'id, tenant_id, trigger_pattern, lesson, source, times_applied, effectiveness_score, last_applied_at, created_at';

/** Module-level timestamp for throttling prune operations (max once per hour). */
let lastPruneTimestamp = 0;

type FailureLessonKind =
  | 'missing_path'
  | 'approval_pending'
  | 'blocked_command'
  | 'command_not_found'
  | 'permission_denied'
  | 'generic_failure';

interface AbstractedFailureLesson {
  triggerPattern: string;
  lesson: string;
}

const FILE_GROUNDING_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'search_files',
  'glob_search',
]);

const UNIX_ABSOLUTE_PATH_RE = /(^|[\s("'`])(\/(?:[^/\s"'`]+\/)*[^/\s"'`]+)/g;
const WINDOWS_ABSOLUTE_PATH_RE = /(^|[\s("'`])([A-Za-z]:\\(?:[^\\\s"'`]+\\)*[^\\\s"'`]+)/g;
const APPROVAL_ID_RE = /\b(?:approval(?:[_-]request)?|request)[-_][a-z0-9]+\b/gi;
const APPROVAL_FLOW_RE = /\bapproval\b|\b\/approve\b|approval[_-]?request[_-]?id/i;
const BLOCKED_COMMAND_RE = /\b(?:blocked|not allowed|requires?\s+[A-Z0-9_]+|workspace_only policy|rbac|sandbox is unavailable|path not allowed)\b/i;
const COMMAND_NOT_FOUND_RE = /\bcommand not found\b|\bnot recognized as an internal or external command\b/i;
const PERMISSION_DENIED_RE = /\bpermission denied\b|\bforbidden\b|\bunauthorized\b/i;
const MISSING_PATH_RE = /\benoent\b|\bno such file or directory\b|\bfile not found\b|\bcannot find\b|\bdoes not exist\b/i;
const RAW_FAILURE_RE = /\b(?:failed|error|stderr|exit code|enoent|approval|blocked|not allowed|permission denied|command not found|timed out)\b/i;

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function redactDirtyPayload(text: string): string {
  return normalizeWhitespace(
    text
      .replace(UNIX_ABSOLUTE_PATH_RE, '$1[path]')
      .replace(WINDOWS_ABSOLUTE_PATH_RE, '$1[path]')
      .replace(APPROVAL_ID_RE, '[approval-id]'),
  );
}

function extractToolName(triggerPattern: string): string | null {
  const idx = triggerPattern.indexOf(':');
  const toolName = (idx >= 0 ? triggerPattern.slice(0, idx) : triggerPattern).trim();
  return toolName.length > 0 ? toolName : null;
}

function classifyFailureKind(text: string): FailureLessonKind | null {
  if (APPROVAL_FLOW_RE.test(text)) return 'approval_pending';
  if (BLOCKED_COMMAND_RE.test(text)) return 'blocked_command';
  if (COMMAND_NOT_FOUND_RE.test(text)) return 'command_not_found';
  if (PERMISSION_DENIED_RE.test(text)) return 'permission_denied';
  if (MISSING_PATH_RE.test(text)) return 'missing_path';
  return null;
}

function buildAbstractFailureLesson(
  toolName: string,
  kind: FailureLessonKind,
): AbstractedFailureLesson {
  switch (kind) {
    case 'missing_path':
      return {
        triggerPattern: `${toolName}: failure:missing_path`,
        lesson: FILE_GROUNDING_TOOLS.has(toolName)
          ? `When "${toolName}" cannot find a target path, first locate the file via list/search/import-follow before retrying.`
          : `When "${toolName}" fails because the target path is missing, verify the exact resource path before retrying.`,
      };
    case 'approval_pending':
      return {
        triggerPattern: `${toolName}: failure:approval_pending`,
        lesson: `When "${toolName}" requires approval, surface the approval state and wait for approval before retrying.`,
      };
    case 'blocked_command':
      return {
        triggerPattern: `${toolName}: failure:blocked_command`,
        lesson: `When "${toolName}" is blocked by runtime policy, switch to a safer allowed tool, command, or workspace path instead of retrying the same action.`,
      };
    case 'command_not_found':
      return {
        triggerPattern: `${toolName}: failure:command_not_found`,
        lesson: `When "${toolName}" fails because a command is unavailable, verify the command exists in the current environment before retrying.`,
      };
    case 'permission_denied':
      return {
        triggerPattern: `${toolName}: failure:permission_denied`,
        lesson: `When "${toolName}" fails on permissions, validate the allowed scope and required privileges before retrying.`,
      };
    case 'generic_failure':
      return {
        triggerPattern: `${toolName}: failure:generic`,
        lesson: `When "${toolName}" fails, capture the blocker at a method level, validate prerequisites, and avoid reusing raw stderr details as future guidance.`,
      };
  }
}

function abstractFailureLesson(toolName: string, errorSummary: string): AbstractedFailureLesson {
  const normalized = normalizeWhitespace(errorSummary);
  const kind = classifyFailureKind(normalized)
    ?? (RAW_FAILURE_RE.test(normalized) ? 'generic_failure' : null)
    ?? (redactDirtyPayload(normalized) !== normalized ? 'generic_failure' : null)
    ?? 'generic_failure';
  return buildAbstractFailureLesson(toolName, kind);
}

function sanitizeLessonForReuse(entry: Lesson): Lesson | null {
  if (entry.source === 'user_correction') return entry;

  const toolName = extractToolName(entry.trigger_pattern);
  const combined = `${entry.trigger_pattern}\n${entry.lesson}`;
  const normalizedCombined = normalizeWhitespace(combined);
  const redactedCombined = redactDirtyPayload(combined);

  if (
    entry.source === 'auto_feedback'
    && toolName
    && (classifyFailureKind(combined) || RAW_FAILURE_RE.test(combined) || redactedCombined !== normalizedCombined)
  ) {
    const abstracted = abstractFailureLesson(toolName, combined);
    return {
      ...entry,
      trigger_pattern: abstracted.triggerPattern,
      lesson: abstracted.lesson,
    };
  }

  if (entry.source !== 'auto_feedback' && entry.source !== 'auto_success') {
    return entry;
  }

  if (redactedCombined === normalizedCombined) return entry;

  const triggerPattern = redactDirtyPayload(entry.trigger_pattern);
  const lesson = redactDirtyPayload(entry.lesson);
  if (!triggerPattern || !lesson) return null;

  return {
    ...entry,
    trigger_pattern: triggerPattern,
    lesson,
  };
}

function prepareLessonsForReuse(entries: Lesson[], limit?: number): Lesson[] {
  const prepared: Lesson[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const reusable = sanitizeLessonForReuse(entry);
    if (!reusable) continue;

    const key = `${reusable.trigger_pattern}\u0000${reusable.lesson}`;
    if (seen.has(key)) continue;
    seen.add(key);
    prepared.push(reusable);

    if (typeof limit === 'number' && prepared.length >= limit) break;
  }

  return prepared;
}

/**
 * Tokenize text into a set of lowercase words and CJK characters.
 */
function tokenize(text: string): Set<string> {
  return new Set(tokenizeText(text).filter(token => !isHanToken(token) || hanTokenLength(token) >= 2));
}

/** A stored self-learning lesson */
export interface Lesson {
  id: number;
  tenant_id: string;
  trigger_pattern: string;
  lesson: string;
  source: string | null;
  times_applied: number;
  effectiveness_score: number;
  last_applied_at: string | null;
  created_at: string;
}

/** A recorded tool execution outcome */
export interface ToolOutcome {
  id: number;
  tenant_id: string;
  chat_id: string;
  turn_id: string;
  iteration: number;
  tool_name: string;
  tool_call_id: string;
  outcome: 'success' | 'error';
  error_summary: string | null;
  duration_ms: number;
  created_at: string;
}

/**
 * Save a lesson for future reuse.
 */
export function saveLesson(
  trigger: string,
  lesson: string,
  source?: string,
  tenantId = 'default',
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO lessons (tenant_id, trigger_pattern, lesson, source)
    VALUES (?, ?, ?, ?)
  `).run(tenantId, trigger, lesson, source ?? null);
}

/**
 * Get lessons, most recent first.
 */
export function getLessons(tenantId = 'default', limit?: number): Lesson[] {
  const db = getDb();
  if (typeof limit === 'number') {
    return db.prepare(`
      SELECT ${LESSON_COLUMNS}
      FROM lessons
      WHERE tenant_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tenantId, limit) as Lesson[];
  }

  return db.prepare(`
    SELECT ${LESSON_COLUMNS}
    FROM lessons
    WHERE tenant_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(tenantId) as Lesson[];
}

/**
 * Search lessons by trigger pattern using simple LIKE matching.
 */
export function searchLessons(query: string, tenantId = 'default'): Lesson[] {
  const db = getDb();
  return db.prepare(`
    SELECT ${LESSON_COLUMNS}
    FROM lessons
    WHERE tenant_id = ? AND trigger_pattern LIKE ?
    ORDER BY created_at DESC, id DESC
  `).all(tenantId, `%${query}%`) as Lesson[];
}

/**
 * Increment times_applied for a lesson row.
 */
export function incrementApplied(lessonId: number): void {
  const db = getDb();
  db.prepare(`
    UPDATE lessons
    SET times_applied = times_applied + 1,
        last_applied_at = datetime('now')
    WHERE id = ?
  `).run(lessonId);
}

// ---------------------------------------------------------------------------
// Feedback loop functions
// ---------------------------------------------------------------------------

/**
 * Record the outcome of a tool execution for analytics and lesson generation.
 */
export function recordToolOutcome(params: {
  tenantId?: string;
  chatId: string;
  turnId: string;
  iteration: number;
  toolName: string;
  toolCallId: string;
  outcome: 'success' | 'error';
  errorSummary?: string;
  durationMs?: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO tool_outcomes (tenant_id, chat_id, turn_id, iteration, tool_name, tool_call_id, outcome, error_summary, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.tenantId ?? 'default',
    params.chatId,
    params.turnId,
    params.iteration,
    params.toolName,
    params.toolCallId,
    params.outcome,
    params.errorSummary ?? null,
    params.durationMs ?? 0,
  );
}

/**
 * Auto-generate a lesson from a tool failure. Deduplicates by checking if the
 * same trigger_pattern was recorded within the last 24 hours.
 */
export function autoGenerateLesson(
  toolName: string,
  errorSummary: string,
  tenantId = 'default',
): void {
  const db = getDb();
  const abstracted = abstractFailureLesson(toolName, errorSummary);
  const triggerPattern = abstracted.triggerPattern;

  // Dedup: check for same trigger within 24h
  const existing = db.prepare(`
    SELECT id FROM lessons
    WHERE tenant_id = ? AND trigger_pattern = ? AND created_at > datetime('now', '-1 day')
    LIMIT 1
  `).get(tenantId, triggerPattern);

  if (existing) return;

  db.prepare(`
    INSERT INTO lessons (tenant_id, trigger_pattern, lesson, source)
    VALUES (?, ?, ?, 'auto_feedback')
  `).run(tenantId, triggerPattern, abstracted.lesson);
}

/**
 * Auto-generate a lesson from a successful tool execution.
 * Deduplicates by trigger pattern within 7 days.
 */
export function autoGenerateSuccessLesson(
  toolName: string,
  successSummary: string,
  tenantId = 'default',
): void {
  const normalized = successSummary.trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!normalized) return;
  const db = getDb();
  const triggerPattern = `${toolName}: success:${normalized}`;

  const existing = db.prepare(`
    SELECT id FROM lessons
    WHERE tenant_id = ? AND trigger_pattern = ? AND created_at > datetime('now', '-7 day')
    LIMIT 1
  `).get(tenantId, triggerPattern);
  if (existing) return;

  db.prepare(`
    INSERT INTO lessons (tenant_id, trigger_pattern, lesson, source)
    VALUES (?, ?, ?, 'auto_success')
  `).run(
    tenantId,
    triggerPattern,
    `Successful pattern with "${toolName}": ${normalized}. Reuse this approach when constraints are similar.`,
  );
}

/**
 * Convert explicit user corrections into high-priority lessons.
 */
export function recordUserCorrectionLesson(
  userFeedback: string,
  tenantId = 'default',
): void {
  const normalized = userFeedback.trim().replace(/\s+/g, ' ').slice(0, 220);
  if (!normalized) return;
  const db = getDb();
  const triggerPattern = `user_correction:${normalized}`;

  const existing = db.prepare(`
    SELECT id FROM lessons
    WHERE tenant_id = ? AND trigger_pattern = ? AND created_at > datetime('now', '-7 day')
    LIMIT 1
  `).get(tenantId, triggerPattern);
  if (existing) return;

  db.prepare(`
    INSERT INTO lessons (tenant_id, trigger_pattern, lesson, source, effectiveness_score)
    VALUES (?, ?, ?, 'user_correction', 0.9)
  `).run(
    tenantId,
    triggerPattern,
    `User correction signal: ${normalized}. Treat this as a high-priority constraint in future similar tasks.`,
  );
}

/**
 * Search lessons relevant to a specific tool, ordered by effectiveness.
 */
export function searchLessonsForTool(
  toolName: string,
  tenantId = 'default',
  limit = 3,
): Lesson[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${LESSON_COLUMNS}
    FROM lessons
    WHERE tenant_id = ? AND trigger_pattern LIKE ?
    ORDER BY effectiveness_score * (1.0 / (1.0 + (julianday('now') - julianday(created_at)) / 30.0)) DESC, created_at DESC
  `).all(tenantId, `${toolName}:%`) as Lesson[];
  return prepareLessonsForReuse(rows, limit);
}

/**
 * Update lesson effectiveness using exponential moving average.
 * score = score * 0.8 + (succeeded ? 0.2 : -0.1)
 * Clamped to [-1.0, 1.0].
 */
export function updateEffectiveness(lessonId: number, succeeded: boolean): void {
  const db = getDb();
  const delta = succeeded ? 0.2 : -0.1;
  db.prepare(`
    UPDATE lessons
    SET effectiveness_score = MAX(-1.0, MIN(1.0, effectiveness_score * 0.8 + ?)),
        last_applied_at = datetime('now'),
        times_applied = times_applied + 1
    WHERE id = ?
  `).run(delta, lessonId);
}

/**
 * Get ranked lessons for context building. Filters out ineffective lessons
 * (score <= -0.5) and orders by effectiveness score descending.
 */
export function getRankedLessons(tenantId = 'default', limit = 10): Lesson[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${LESSON_COLUMNS}
    FROM lessons
    WHERE tenant_id = ? AND effectiveness_score > -0.5
    ORDER BY effectiveness_score * (1.0 / (1.0 + (julianday('now') - julianday(created_at)) / 30.0)) DESC, created_at DESC
  `).all(tenantId) as Lesson[];
  return prepareLessonsForReuse(rows, limit);
}

/**
 * Get ranked lessons filtered by relevance to the current query.
 *
 * - Tokenizes the query and only includes lessons whose trigger_pattern or lesson
 *   text has token overlap with the query.
 * - Exception: `user_correction` source lessons are always included.
 * - Applies time decay and effectiveness filtering.
 * - Opportunistically prunes expired low-value lessons (max once per hour).
 */
export function getRankedLessonsForContext(
  query: string,
  tenantId = 'default',
  limit = 5,
): Lesson[] {
  // Opportunistic pruning (max once per hour)
  const now = Date.now();
  if (now - lastPruneTimestamp > 3_600_000) {
    lastPruneTimestamp = now;
    pruneExpiredLessons(tenantId);
  }

  const db = getDb();
  const candidates = db.prepare(`
    SELECT ${LESSON_COLUMNS}
    FROM lessons
    WHERE tenant_id = ? AND effectiveness_score > -0.5
    ORDER BY effectiveness_score * (1.0 / (1.0 + (julianday('now') - julianday(created_at)) / 30.0)) DESC, created_at DESC
  `).all(tenantId) as Lesson[];

  const queryTokens = tokenize(query);
  const filtered: Lesson[] = [];
  const reusableCandidates = prepareLessonsForReuse(candidates);

  for (const lesson of reusableCandidates) {
    if (filtered.length >= limit) break;

    // Always include user corrections
    if (lesson.source === 'user_correction') {
      filtered.push(lesson);
      continue;
    }

    // Check token overlap
    if (queryTokens.size === 0) continue;
    const lessonTokens = tokenize(`${lesson.trigger_pattern} ${lesson.lesson}`);
    for (const token of lessonTokens) {
      if (queryTokens.has(token)) {
        filtered.push(lesson);
        break;
      }
    }
  }

  return filtered;
}

/**
 * Delete auto-generated lessons older than 90 days with low effectiveness.
 * Only removes `auto_feedback` and `auto_success` source lessons with score < 0.1.
 */
export function pruneExpiredLessons(tenantId = 'default'): number {
  const db = getDb();
  const result = db.prepare(`
    DELETE FROM lessons
    WHERE tenant_id = ?
      AND source IN ('auto_feedback', 'auto_success')
      AND created_at < datetime('now', '-90 days')
      AND effectiveness_score < 0.1
  `).run(tenantId);
  return result.changes;
}

/**
 * Reset the prune throttle timestamp (for testing only).
 */
export function resetPruneTimestamp(): void {
  lastPruneTimestamp = 0;
}
