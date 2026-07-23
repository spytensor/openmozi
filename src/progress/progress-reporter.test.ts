import { describe, it, expect, afterEach } from 'vitest';
import {
  startTracking,
  reportTaskStarted,
  reportTaskCompleted,
  reportTaskFailed,
  reportTaskCancelled,
  reportTaskRetryScheduled,
  stopTracking,
  formatProgressText,
  _getExecutionState,
  _clearAllState,
} from './progress-reporter.js';
import { on, removeAllListeners, type ProgressEvent } from './event-bus.js';

afterEach(() => {
  removeAllListeners();
  _clearAllState();
});

describe('progress/progress-reporter', () => {
  describe('DAG tracking lifecycle', () => {
    it('startTracking creates state and emits dag_created', () => {
      const events: ProgressEvent[] = [];
      on((e) => events.push(e));

      startTracking('dag-1', 5);

      const state = _getExecutionState('dag-1');
      expect(state).toBeDefined();
      expect(state!.totalTasks).toBe(5);
      expect(state!.completedTasks).toBe(0);
      expect(state!.runningTasks).toBe(0);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('dag_created');
      expect(events[0].totalTasks).toBe(5);
      expect(events[0].pendingTasks).toBe(5);
    });

    it('threads parentTaskId onto task lifecycle events (Issue #624)', () => {
      const events: ProgressEvent[] = [];
      on((e) => events.push(e));

      startTracking('dag-p', 2);
      reportTaskStarted('dag-p', 'sub-1', 'Build', 'root-1');
      reportTaskCompleted('dag-p', 'sub-1', 'Build', 10, 'root-1');
      reportTaskFailed('dag-p', 'sub-2', 'Test', 'boom', 'root-1');
      reportTaskCancelled('dag-p', 'sub-3', 'Deploy', 'stopped', 'root-1');

      const lifecycle = events.filter((e) =>
        e.type === 'task_started' || e.type === 'task_completed' || e.type === 'task_failed' || e.type === 'task_cancelled',
      );
      expect(lifecycle).toHaveLength(4);
      expect(lifecycle.every((e) => e.parentTaskId === 'root-1')).toBe(true);

      // A plan root reported with no parent leaves parentTaskId undefined.
      reportTaskStarted('dag-p', 'root-1', 'Ship the thing');
      const rootStart = events.filter((e) => e.type === 'task_started').at(-1);
      expect(rootStart?.parentTaskId).toBeUndefined();
    });

    it('reportTaskStarted increments runningTasks and emits event', () => {
      const events: ProgressEvent[] = [];
      startTracking('dag-1', 3);
      on((e) => events.push(e));

      reportTaskStarted('dag-1', 't1', 'Analyze code');

      const state = _getExecutionState('dag-1')!;
      expect(state.runningTasks).toBe(1);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('task_started');
      expect(events[0].taskTitle).toBe('Analyze code');
    });

    it('reportTaskCompleted updates state and emits task_completed + overall_progress', () => {
      const events: ProgressEvent[] = [];
      startTracking('dag-1', 3);
      reportTaskStarted('dag-1', 't1', 'Analyze code');
      on((e) => events.push(e));

      reportTaskCompleted('dag-1', 't1', 'Analyze code', 1200, undefined, 'Found 3 modules, all typed.');

      const state = _getExecutionState('dag-1')!;
      expect(state.completedTasks).toBe(1);
      expect(state.runningTasks).toBe(0);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task_completed');
      expect(events[0].elapsed_ms).toBe(1200);
      // Result excerpt rides the completion event (plan-card step disclosure).
      expect(events[0].detail).toBe('Found 3 modules, all typed.');
      expect(events[1].type).toBe('overall_progress');
      expect(events[1].completedTasks).toBe(1);
      expect(events[1].totalTasks).toBe(3);
      expect(events[1].pendingTasks).toBe(2);
    });

    it('reportTaskFailed updates state and emits task_failed + overall_progress', () => {
      const events: ProgressEvent[] = [];
      startTracking('dag-1', 3);
      reportTaskStarted('dag-1', 't1', 'Run tests');
      on((e) => events.push(e));

      reportTaskFailed('dag-1', 't1', 'Run tests', 'timeout after 30s');

      const state = _getExecutionState('dag-1')!;
      expect(state.failedTasks).toBe(1);
      expect(state.runningTasks).toBe(0);

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task_failed');
      expect(events[0].error).toBe('timeout after 30s');
      expect(events[1].type).toBe('overall_progress');
    });

    it('reportTaskCancelled emits task_cancelled + overall_progress', () => {
      const events: ProgressEvent[] = [];
      startTracking('dag-1', 2);
      reportTaskStarted('dag-1', 't1', 'Cancelable');
      on((e) => events.push(e));

      reportTaskCancelled('dag-1', 't1', 'Cancelable', 'user request');

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('task_cancelled');
      expect(events[0].error).toBe('user request');
      expect(events[1].type).toBe('overall_progress');
    });

    it('keeps retry and never-started cancellation counters truthful', () => {
      startTracking('dag-1', 2);
      reportTaskStarted('dag-1', 't1', 'Retrying');
      reportTaskRetryScheduled('dag-1', 't1');
      expect(_getExecutionState('dag-1')?.runningTasks).toBe(0);

      reportTaskStarted('dag-1', 't1', 'Retrying');
      reportTaskCompleted('dag-1', 't1', 'Retrying', 10);
      reportTaskCancelled('dag-1', 't2', 'Never started', 'upstream cancelled');

      const state = _getExecutionState('dag-1')!;
      expect(state.completedTasks).toBe(1);
      expect(state.failedTasks).toBe(1);
      expect(state.runningTasks).toBe(0);
    });

    it('stopTracking cleans up state', () => {
      startTracking('dag-1', 3);
      expect(_getExecutionState('dag-1')).toBeDefined();

      stopTracking('dag-1');
      expect(_getExecutionState('dag-1')).toBeUndefined();
    });

    it('full lifecycle: start -> tasks -> stop', () => {
      const events: ProgressEvent[] = [];
      on((e) => events.push(e));

      startTracking('dag-1', 2);
      reportTaskStarted('dag-1', 't1', 'Step 1');
      reportTaskCompleted('dag-1', 't1', 'Step 1', 500);
      reportTaskStarted('dag-1', 't2', 'Step 2');
      reportTaskCompleted('dag-1', 't2', 'Step 2', 800);
      stopTracking('dag-1');

      const state = _getExecutionState('dag-1');
      expect(state).toBeUndefined();

      // dag_created + task_started + task_completed + overall_progress + task_started + task_completed + overall_progress = 7
      expect(events).toHaveLength(7);
      expect(events[0].type).toBe('dag_created');
      expect(events[6].type).toBe('overall_progress');
      expect(events[6].completedTasks).toBe(2);
    });
  });

  describe('formatProgressText', () => {
    it('formats task_started', () => {
      const text = formatProgressText({
        type: 'task_started',
        taskId: 't1',
        taskTitle: 'Analyze code',
        completedTasks: 2,
        totalTasks: 7,
      });
      expect(text).toBe('[2/7] Starting: Analyze code');
    });

    it('formats task_completed with elapsed time', () => {
      const text = formatProgressText({
        type: 'task_completed',
        taskId: 't1',
        taskTitle: 'Analyze code',
        completedTasks: 3,
        totalTasks: 7,
        elapsed_ms: 1200,
      });
      expect(text).toBe('[3/7] Done: Analyze code (1.2s)');
    });

    it('formats task_failed', () => {
      const text = formatProgressText({
        type: 'task_failed',
        taskId: 't1',
        taskTitle: 'Run tests',
        error: 'timeout',
      });
      expect(text).toBe('[!] Failed: Run tests: timeout');
    });

    it('formats task_cancelled', () => {
      const text = formatProgressText({
        type: 'task_cancelled',
        taskId: 't1',
        taskTitle: 'Run tests',
        error: 'user request',
      });
      expect(text).toBe('[x] Cancelled: Run tests: user request');
    });

    it('formats overall_progress', () => {
      const text = formatProgressText({
        type: 'overall_progress',
        completedTasks: 3,
        totalTasks: 7,
        runningTasks: 2,
        pendingTasks: 2,
      });
      expect(text).toBe('Progress: 3/7 complete, 2 running, 2 pending');
    });

    it('formats agent_spawned', () => {
      const text = formatProgressText({
        type: 'agent_spawned',
        agentId: 'a1',
        agentRole: 'researcher',
      });
      expect(text).toBe('Agent spawned: researcher');
    });

    it('formats agent_completed', () => {
      const text = formatProgressText({
        type: 'agent_completed',
        agentId: 'a1',
        summary: 'Done',
      });
      expect(text).toBe('Agent completed: a1 - Done');
    });

    it('formats agent_failed', () => {
      const text = formatProgressText({
        type: 'agent_failed',
        agentId: 'a1',
        error: 'OOM',
      });
      expect(text).toBe('Agent failed: a1: OOM');
    });

    it('formats budget_warning', () => {
      const text = formatProgressText({
        type: 'budget_warning',
        level: 'soft',
        usagePercent: 75,
      });
      expect(text).toBe('Token budget: soft (75%)');
    });

    it('formats tool_call', () => {
      const text = formatProgressText({
        type: 'tool_call',
        toolName: 'shell_exec',
        intent: 'pnpm vitest run',
      });
      expect(text).toBe('Action: pnpm vitest run');
    });

    it('formats turn_state', () => {
      const text = formatProgressText({
        type: 'turn_state',
        turnState: 'EXECUTING',
        detail: 'brain execution',
      });
      expect(text).toBe('Phase: executing - brain execution');
    });

    it('formats worker_status heartbeat updates', () => {
      const text = formatProgressText({
        type: 'worker_status',
        runtimeLabel: 'Claude Code',
        workerStatus: 'running',
        elapsed_ms: 65_000,
        heartbeat: true,
      });
      expect(text).toBe('Claude Code: still running (1m5s)');
    });

    it('formats task_started with missing counts', () => {
      const text = formatProgressText({
        type: 'task_started',
        taskTitle: 'Test',
      });
      expect(text).toBe('[?] Starting: Test');
    });

    it('formats elapsed time in milliseconds', () => {
      const text = formatProgressText({
        type: 'task_completed',
        taskTitle: 'Quick task',
        completedTasks: 1,
        totalTasks: 1,
        elapsed_ms: 500,
      });
      expect(text).toBe('[1/1] Done: Quick task (500ms)');
    });

    it('formats elapsed time in minutes', () => {
      const text = formatProgressText({
        type: 'task_completed',
        taskTitle: 'Long task',
        completedTasks: 1,
        totalTasks: 1,
        elapsed_ms: 125000,
      });
      expect(text).toBe('[1/1] Done: Long task (2m5s)');
    });
  });
});
