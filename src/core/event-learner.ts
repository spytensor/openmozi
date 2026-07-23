/**
 * Event Log Learning Cycle — extract patterns and lessons from event history.
 *
 * Reads the event_log table to identify repeated failures, common errors,
 * and successful strategies. Generates "lessons" saved to memory_facts.
 */

import { getDb } from '../store/db.js';
import { saveFact } from '../memory/long-term.js';
import pino from 'pino';

const logger = pino({ name: 'mozi:event-learner' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventRow {
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: string;
  created_at: string;
}

interface FailurePattern {
  entity_type: string;
  entity_id: string;
  failure_count: number;
  last_error: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze recent events and extract lessons.
 * @param tenantId Tenant scope
 * @param lookbackHours How far back to analyze (default 24)
 * @returns Array of lesson strings generated
 */
export function extractLessons(
  tenantId = 'default',
  lookbackHours = 24,
): string[] {
  const db = getDb();
  const lessons: string[] = [];

  // Find repeated failures on the same entity
  const failures = db.prepare(`
    SELECT entity_type, entity_id, COUNT(*) as failure_count,
           MAX(payload) as last_payload
    FROM event_log
    WHERE tenant_id = ?
      AND event_type LIKE '%failed%'
      AND created_at >= datetime('now', '-' || ? || ' hours')
    GROUP BY entity_type, entity_id
    HAVING COUNT(*) >= 3
    ORDER BY failure_count DESC
    LIMIT 10
  `).all(tenantId, lookbackHours) as Array<{
    entity_type: string;
    entity_id: string;
    failure_count: number;
    last_payload: string;
  }>;

  for (const f of failures) {
    let errorDetail = '';
    try {
      const payload = JSON.parse(f.last_payload);
      errorDetail = payload.error || payload.reason || payload.message || '';
    } catch {
      errorDetail = f.last_payload?.slice(0, 200) ?? '';
    }

    const lesson = `Repeated failure (${f.failure_count}x) on ${f.entity_type}/${f.entity_id}: ${errorDetail}`.slice(0, 500);
    lessons.push(lesson);

    // Save to memory
    saveFact(
      'global',
      'lesson',
      `failure_pattern:${f.entity_type}:${f.entity_id}`,
      lesson,
      'event_learner',
      tenantId,
    );
  }

  // Find common error types
  const errorTypes = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM event_log
    WHERE tenant_id = ?
      AND (event_type LIKE '%error%' OR event_type LIKE '%failed%')
      AND created_at >= datetime('now', '-' || ? || ' hours')
    GROUP BY event_type
    HAVING COUNT(*) >= 5
    ORDER BY count DESC
    LIMIT 5
  `).all(tenantId, lookbackHours) as Array<{ event_type: string; count: number }>;

  for (const et of errorTypes) {
    const lesson = `Frequent error pattern: "${et.event_type}" occurred ${et.count} times in last ${lookbackHours}h`;
    lessons.push(lesson);

    saveFact(
      'global',
      'lesson',
      `error_frequency:${et.event_type}`,
      lesson,
      'event_learner',
      tenantId,
    );
  }

  // Find successful strategies (tasks that completed after earlier failures)
  const recoveries = db.prepare(`
    SELECT e1.entity_id, e1.entity_type
    FROM event_log e1
    WHERE e1.tenant_id = ?
      AND e1.event_type LIKE '%completed%'
      AND e1.created_at >= datetime('now', '-' || ? || ' hours')
      AND EXISTS (
        SELECT 1 FROM event_log e2
        WHERE e2.tenant_id = e1.tenant_id
          AND e2.entity_id = e1.entity_id
          AND e2.entity_type = e1.entity_type
          AND e2.event_type LIKE '%failed%'
          AND e2.created_at < e1.created_at
      )
    LIMIT 5
  `).all(tenantId, lookbackHours) as Array<{ entity_id: string; entity_type: string }>;

  for (const r of recoveries) {
    const lesson = `Recovery success: ${r.entity_type}/${r.entity_id} completed after earlier failures`;
    lessons.push(lesson);
  }

  if (lessons.length > 0) {
    logger.info({ count: lessons.length, tenantId }, 'Lessons extracted from event log');
  }

  return lessons;
}

/**
 * Get all stored lessons from memory.
 */
export function getStoredLessons(tenantId = 'default'): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT value FROM memory_facts
    WHERE tenant_id = ?
      AND category = 'lesson'
      AND source = 'event_learner'
    ORDER BY updated_at DESC
    LIMIT 20
  `).all(tenantId) as Array<{ value: string }>;

  return rows.map(r => r.value);
}
