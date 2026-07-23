import pino from 'pino';

const logger = pino({ name: 'mozi:scheduler:reminders' });

const CHECK_INTERVAL_MS = 60_000;

export interface SchedulerTaskInput {
  id?: string;
  name?: string;
  interval_minutes: number;
  run: () => void | Promise<void>;
}

interface InternalTask {
  id: string;
  name?: string;
  interval_minutes: number;
  run: () => void | Promise<void>;
  next_run_at: number;
  last_run_at: number | null;
  running: boolean;
}

export interface ScheduledTask {
  id: string;
  name?: string;
  interval_minutes: number;
  next_run_at: number;
  last_run_at: number | null;
}

const tasks = new Map<string, InternalTask>();
let ticker: ReturnType<typeof setInterval> | null = null;
let taskCounter = 0;

function toPublicTask(task: InternalTask): ScheduledTask {
  return {
    id: task.id,
    name: task.name,
    interval_minutes: task.interval_minutes,
    next_run_at: task.next_run_at,
    last_run_at: task.last_run_at,
  };
}

async function runDueTasks(): Promise<void> {
  const now = Date.now();
  const due: InternalTask[] = [];

  for (const task of tasks.values()) {
    if (task.running) continue;
    if (now >= task.next_run_at) {
      due.push(task);
    }
  }

  if (due.length === 0) return;

  await Promise.allSettled(due.map(async (task) => {
    task.running = true;
    task.next_run_at = now + (task.interval_minutes * 60_000);
    task.last_run_at = now;

    try {
      await Promise.resolve(task.run());
    } catch (err) {
      logger.error(
        {
          taskId: task.id,
          err: err instanceof Error ? err.message : String(err),
        },
        'Scheduled task execution failed',
      );
    } finally {
      task.running = false;
    }
  }));
}

/**
 * Register a recurring task.
 * Returns the task ID.
 */
export function schedule(task: SchedulerTaskInput): string {
  if (typeof task.interval_minutes !== 'number' || !Number.isFinite(task.interval_minutes) || task.interval_minutes <= 0) {
    throw new Error('"interval_minutes" must be a positive number');
  }

  const taskId = task.id ?? `task_${++taskCounter}`;
  if (tasks.has(taskId)) {
    throw new Error(`Task already scheduled: ${taskId}`);
  }

  const now = Date.now();
  tasks.set(taskId, {
    id: taskId,
    name: task.name,
    interval_minutes: task.interval_minutes,
    run: task.run,
    next_run_at: now + (task.interval_minutes * 60_000),
    last_run_at: null,
    running: false,
  });

  return taskId;
}

/**
 * Cancel a scheduled task.
 */
export function cancel(taskId: string): boolean {
  return tasks.delete(taskId);
}

/**
 * List all scheduled tasks.
 */
export function list(): ScheduledTask[] {
  return Array.from(tasks.values()).map(toPublicTask);
}

/**
 * Start polling every 60 seconds for due tasks.
 */
export function start(): void {
  if (ticker) return;
  ticker = setInterval(() => {
    void runDueTasks();
  }, CHECK_INTERVAL_MS);
  void runDueTasks();
}

/**
 * Stop the scheduler polling interval.
 */
export function stop(): void {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

/**
 * Test helper: reset all state.
 */
export function reset(): void {
  stop();
  tasks.clear();
  taskCounter = 0;
}
