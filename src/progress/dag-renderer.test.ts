import { describe, it, expect } from 'vitest';
import { renderDagProgress, type DagTaskStatus } from './dag-renderer.js';

describe('progress/dag-renderer', () => {
  it('renders all pending tasks', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'Analyze requirements', status: 'pending' },
      { title: 'Write implementation', status: 'pending' },
      { title: 'Run tests', status: 'pending' },
    ];

    const result = renderDagProgress(tasks);

    expect(result).toBe(
      'Task plan (3 steps):\n' +
      '1. [ ] Analyze requirements\n' +
      '2. [ ] Write implementation\n' +
      '3. [ ] Run tests',
    );
  });

  it('renders mixed status including running', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'Analyze requirements', status: 'completed', elapsed_ms: 1800 },
      { title: 'Write implementation', status: 'running' },
      { title: 'Run tests', status: 'pending' },
    ];

    const result = renderDagProgress(tasks);

    expect(result).toContain('1. [x] Analyze requirements (1.8s)');
    expect(result).toContain('2. [>] Write implementation...');
    expect(result).toContain('3. [ ] Run tests');
  });

  it('renders failed tasks', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'Setup', status: 'completed', elapsed_ms: 500 },
      { title: 'Build', status: 'failed' },
    ];

    const result = renderDagProgress(tasks);

    expect(result).toContain('1. [x] Setup (500ms)');
    expect(result).toContain('2. [!] Build');
  });

  it('formats milliseconds correctly', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'Fast task', status: 'completed', elapsed_ms: 50 },
    ];
    expect(renderDagProgress(tasks)).toContain('(50ms)');
  });

  it('formats minutes correctly', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'Slow task', status: 'completed', elapsed_ms: 125_000 },
    ];
    expect(renderDagProgress(tasks)).toContain('(2m5s)');
  });

  it('renders completed without elapsed', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'Done', status: 'completed' },
    ];
    const result = renderDagProgress(tasks);
    expect(result).toBe('Task plan (1 steps):\n1. [x] Done');
  });

  it('contains no emoji', () => {
    const tasks: DagTaskStatus[] = [
      { title: 'A', status: 'completed', elapsed_ms: 100 },
      { title: 'B', status: 'running' },
      { title: 'C', status: 'failed' },
      { title: 'D', status: 'pending' },
    ];
    const result = renderDagProgress(tasks);
    // Emoji range check — should not contain any emoji characters
    // eslint-disable-next-line no-control-regex
    expect(result).not.toMatch(/[\u{1F600}-\u{1F64F}]/u);
    expect(result).not.toMatch(/[\u{1F300}-\u{1F5FF}]/u);
    expect(result).not.toMatch(/[\u{2600}-\u{26FF}]/u);
  });
});
