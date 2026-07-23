/**
 * DAG Progress Renderer — renders task DAG status as plain text.
 *
 * Design rule: NO emoji. Plain text only.
 * Indicators: [x] done, [>] running, [ ] pending, [!] failed
 */

/** Status of a single task in the DAG */
export interface DagTaskStatus {
  title: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  elapsed_ms?: number;
}

/**
 * Render a DAG progress view as plain text.
 *
 * Example output:
 * ```
 * Task plan (3 steps):
 * 1. [x] Analyze requirements (1.8s)
 * 2. [>] Write implementation...
 * 3. [ ] Run tests
 * ```
 */
export function renderDagProgress(tasks: DagTaskStatus[]): string {
  const header = `Task plan (${tasks.length} steps):`;
  const lines = tasks.map((task, i) => {
    const num = i + 1;
    switch (task.status) {
      case 'completed': {
        const elapsed = task.elapsed_ms != null ? ` (${formatElapsed(task.elapsed_ms)})` : '';
        return `${num}. [x] ${task.title}${elapsed}`;
      }
      case 'running':
        return `${num}. [>] ${task.title}...`;
      case 'failed': {
        return `${num}. [!] ${task.title}`;
      }
      case 'pending':
      default:
        return `${num}. [ ] ${task.title}`;
    }
  });

  return `${header}\n${lines.join('\n')}`;
}

/**
 * Format elapsed milliseconds as a human-readable string.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}m${remaining}s`;
}
