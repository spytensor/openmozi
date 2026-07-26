/**
 * One model for everything MOZI runs on a schedule.
 *
 * The UI used to show two things with two unrelated interaction models: cron
 * tasks (read-only, no way to create one) and reminders (an inline form bolted
 * onto the bottom of the page). They are the same idea to an operator — "do
 * this later" — so they get one shape, one list and one creation path here.
 *
 * The two are NOT merged in storage, deliberately. A reminder retries because
 * *delivery* failed (the message could not be sent, so back off and resend);
 * `reminders.ts` carries `max_attempts` / `next_attempt_at` / stale-claim
 * recovery for exactly that. A task fails because the *run* went wrong, which
 * is a different thing with different handling. Collapsing the tables would
 * mean dropping the delivery machinery for a unification the operator cannot
 * see — the seam belongs at the model layer, which is where it is.
 */
import type { CronTask } from '../scheduler/cron-tasks.js';
import type { Reminder } from '../scheduler/reminders.js';

/** What the item does when it fires. */
export type ScheduledItemKind = 'prompt' | 'reminder';

export type ScheduledItemStatus = 'scheduled' | 'running' | 'ok' | 'failed' | 'paused' | 'done';

export interface ScheduledItem {
  /** Namespaced so a cron id and a reminder id can never collide. */
  id: string;
  kind: ScheduledItemKind;
  /** What the operator typed: the prompt, or the reminder text. */
  body: string;
  /** Human-readable recurrence, resolved client-side from the fields below. */
  schedule: {
    kind: 'cron' | 'every' | 'at';
    value: string;
    timezone?: string | null;
  };
  status: ScheduledItemStatus;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  runCount: number;
  /** Why the last attempt failed. Null when the last attempt succeeded. */
  error?: string | null;
  permissionLevel?: string | null;
  /** Whether this item can be paused/resumed and re-run on demand. */
  canPause: boolean;
  canRunNow: boolean;
  createdAt?: string | null;
}

function taskStatus(task: CronTask): ScheduledItemStatus {
  if (!task.enabled) return 'paused';
  switch (task.last_status) {
    case 'failed': return 'failed';
    case 'queued': case 'running': case 'retrying': return 'running';
    case 'completed': return 'ok';
    default: return 'scheduled';
  }
}

/**
 * `description` doubles as the prompt for `managed_brain` tasks, so it is the
 * body. Falling back to the handler type would put an internal identifier in
 * front of the operator, which is what this redesign is removing.
 */
export function cronTaskToItem(task: CronTask): ScheduledItem {
  return {
    id: `task:${task.id}`,
    kind: 'prompt',
    body: task.description,
    schedule: {
      kind: task.schedule_kind,
      value: task.schedule_value,
      timezone: task.timezone,
    },
    status: taskStatus(task),
    nextRunAt: task.next_run_at,
    lastRunAt: task.last_run_at,
    runCount: task.run_count,
    error: task.last_error,
    permissionLevel: task.permission_level,
    canPause: true,
    canRunNow: true,
    createdAt: task.created_at,
  };
}

function reminderStatus(reminder: Reminder): ScheduledItemStatus {
  switch (reminder.status) {
    case 'failed': return 'failed';
    case 'delivering': case 'retrying': return 'running';
    case 'delivered': return 'done';
    default: return 'scheduled';
  }
}

export function reminderToItem(reminder: Reminder): ScheduledItem {
  return {
    id: `reminder:${reminder.id}`,
    kind: 'reminder',
    body: reminder.message,
    // A reminder is a one-shot at a wall-clock time — the same thing an `at`
    // task is, so it renders through the same formatter.
    schedule: { kind: 'at', value: reminder.fire_at },
    status: reminderStatus(reminder),
    nextRunAt: reminder.fired ? null : reminder.fire_at,
    lastRunAt: reminder.fired_at,
    runCount: reminder.attempt_count,
    error: reminder.last_error,
    // A reminder only ever sends a message, so it needs no permission level and
    // showing one would imply a capability it does not have.
    permissionLevel: null,
    // Reminders have no enabled flag and firing one early has no meaning.
    canPause: false,
    canRunNow: false,
    createdAt: reminder.created_at,
  };
}

/** Split a namespaced item id back into its store and native id. */
export function parseItemId(id: string): { kind: ScheduledItemKind; nativeId: string } | null {
  const separator = id.indexOf(':');
  if (separator <= 0) return null;
  const prefix = id.slice(0, separator);
  const nativeId = id.slice(separator + 1);
  if (!nativeId) return null;
  if (prefix === 'task') return { kind: 'prompt', nativeId };
  if (prefix === 'reminder') return { kind: 'reminder', nativeId };
  return null;
}

/**
 * Newest work first, but anything still due outranks anything already done —
 * an operator opening this page is looking for what is about to happen.
 */
export function sortItems(items: ScheduledItem[]): ScheduledItem[] {
  const rank = (item: ScheduledItem) => (item.status === 'done' ? 1 : 0);
  return [...items].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const aNext = a.nextRunAt ? Date.parse(a.nextRunAt) : Number.POSITIVE_INFINITY;
    const bNext = b.nextRunAt ? Date.parse(b.nextRunAt) : Number.POSITIVE_INFINITY;
    if (aNext !== bNext) return aNext - bNext;
    return (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  });
}
