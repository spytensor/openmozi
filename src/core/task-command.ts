import { listManagedTasks, type ManagedTaskSummary } from './task-management.js';
import type { TaskStatus } from '../store/task-dag.js';

const STATUS_FILTERS = new Set<TaskStatus | 'all'>([
  'pending',
  'ready',
  'assigned',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
  'all',
]);

const DEFAULT_ACTIVE_STATUSES: TaskStatus[] = ['pending', 'ready', 'assigned', 'running', 'blocked'];

function isStatusFilter(value: string | undefined): value is TaskStatus | 'all' {
  return value !== undefined && STATUS_FILTERS.has(value as TaskStatus | 'all');
}

function formatTaskLine(task: ManagedTaskSummary): string {
  const parts = [
    `[${task.status}]`,
    task.id.slice(0, 8),
    task.title,
  ];

  if (task.assigned_agent) parts.push(`agent=${task.assigned_agent}`);
  if (task.blocked_by.length > 0) {
    parts.push(`blocked_by=${task.blocked_by.map((dep) => dep.title).slice(0, 2).join(', ')}`);
  }
  if (task.tags.length > 0) {
    parts.push(`tags=${task.tags.join(',')}`);
  }

  return `- ${parts.join(' | ')}`;
}

export interface TaskCommandOptions {
  tenantId?: string;
  args?: string;
  limit?: number;
}

/**
 * Build human-readable /tasks command output from persistent task state.
 */
export function formatTasksCommandOutput(options: TaskCommandOptions = {}): string {
  const tenantId = options.tenantId ?? 'default';
  const limit = options.limit ?? 20;
  const rawArgs = options.args?.trim() ?? '';
  const tokens = rawArgs.length > 0 ? rawArgs.split(/\s+/) : [];
  const firstToken = tokens[0]?.toLowerCase();

  const statusFilter = isStatusFilter(firstToken) && firstToken !== 'all'
    ? firstToken
    : undefined;
  const search = isStatusFilter(firstToken)
    ? tokens.slice(1).join(' ').trim() || undefined
    : rawArgs || undefined;

  const tasks = listManagedTasks({
    tenant_id: tenantId,
    status: statusFilter ? statusFilter : rawArgs.toLowerCase() === 'all' ? undefined : [...DEFAULT_ACTIVE_STATUSES],
    search,
    limit,
  });

  if (tasks.length === 0) {
    if (statusFilter) {
      return `No ${statusFilter} tasks found.`;
    }
    if (search) {
      return `No tasks found for query: ${search}`;
    }
    return 'No active tasks.';
  }

  const header = statusFilter
    ? `Tasks (${statusFilter}) — ${tasks.length}`
    : search
      ? `Tasks (query: ${search}) — ${tasks.length}`
      : `Active Tasks — ${tasks.length}`;

  return [
    header,
    ...tasks.map(formatTaskLine),
  ].join('\n');
}
