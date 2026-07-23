import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { resetTelemetryTableFlag, startTurnTrace } from './telemetry.js';
import type { ContextSlotBreakdown } from '../memory/context-builder.js';
import {
  capturePromptSnapshot,
  getPromptSnapshot,
  getRecentPromptSnapshots,
  persistPromptSnapshot,
  pruneOldSnapshots,
  redactSnapshot,
  resetPromptSnapshotTableFlag,
  updatePromptSnapshotAdmission,
  updatePromptSnapshotVerifier,
} from './prompt-snapshot.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

function makeSlotBreakdown(): ContextSlotBreakdown[] {
  return [
    {
      name: 'identity',
      priority: 100,
      tokenCap: 2000,
      rawTokens: 1800,
      usedTokens: 1800,
      included: true,
      itemCount: 1,
      dedupeRule: 'exact',
      freshnessRule: 'immutable',
      fallbackRule: 'trim',
      fallbackApplied: 'none',
    },
    {
      name: 'memory_facts',
      priority: 80,
      tokenCap: 1000,
      rawTokens: 1200,
      usedTokens: 950,
      included: true,
      itemCount: 5,
      dedupeRule: 'line',
      freshnessRule: 'retrieval_scored',
      fallbackRule: 'trim',
      fallbackApplied: 'trimmed',
    },
    {
      name: 'skills',
      priority: 50,
      tokenCap: 500,
      rawTokens: 0,
      usedTokens: 0,
      included: false,
      itemCount: 0,
      dedupeRule: 'exact',
      freshnessRule: 'context_match',
      fallbackRule: 'omit',
      fallbackApplied: 'omitted',
    },
  ];
}

interface CompletionGateDecision {
  status: 'not_required' | 'pending' | 'passed' | 'failed';
  verify_required: boolean;
  summary: string;
  missing_actions: string[];
  failure_reasons: string[];
  notes?: string[];
  managed_worker_pending?: unknown[];
  managed_worker_failures?: unknown[];
  actionable?: boolean;
}

function makeGateDecision(overrides: Partial<CompletionGateDecision> = {}): CompletionGateDecision {
  return {
    status: 'passed',
    verify_required: true,
    summary: 'Verification passed. 1 code file(s) changed.',
    missing_actions: [],
    failure_reasons: [],
    notes: ['1 code file(s) changed'],
    managed_worker_pending: [],
    managed_worker_failures: [],
    actionable: false,
    ...overrides,
  };
}

describe('observer/prompt-snapshot', () => {
  const traceId = 'trace-snap-1';

  it('captures a prompt snapshot with slot breakdown and verifier state', () => {
    const snapshot = capturePromptSnapshot({
      trace_id: traceId,
      tenant_id: 'default',
      chat_id: 'chat-snap-1',
      model: 'gpt-4.1-mini',
      slotBreakdown: makeSlotBreakdown(),
      totalBudget: 8000,
      systemSlotBudget: 4800,
      historyTokenBudget: 3200,
      tools: [
        { name: 'read_file', source: 'builtin' },
        { name: 'shell_exec', source: 'builtin' },
      ],
      gateDecision: makeGateDecision(),
      messageCount: 12,
      systemMessageCount: 3,
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.trace_id).toBe(traceId);
    expect(snapshot.context.slots).toHaveLength(3);
    expect(snapshot.context.slots[0].name).toBe('identity');
    expect(snapshot.context.slots[0].usedTokens).toBe(1800);
    expect(snapshot.context.slots[1].fallbackApplied).toBe('trimmed');
    expect(snapshot.context.slots[2].included).toBe(false);
    expect(snapshot.tools).toHaveLength(2);
    expect(snapshot.verifier.verify_status).toBe('passed');
    expect(snapshot.verifier.verify_required).toBe(true);
    expect(snapshot.runtime_meta.message_count).toBe(12);
    expect(snapshot.runtime_meta.exposed_tool_count).toBe(2);
    expect(snapshot.runtime_meta.task_profile).toBe('general');
    expect(snapshot.runtime_meta.runtime_admission).toBeNull();
    expect(snapshot.runtime_meta.admission_status).toBe('not_required');
  });

  it('handles null gate decision as not_required', () => {
    const snapshot = capturePromptSnapshot({
      trace_id: 'trace-snap-null',
      tenant_id: 'default',
      chat_id: 'chat-snap-null',
      model: 'gpt-4.1-mini',
      slotBreakdown: [],
      totalBudget: 4000,
      systemSlotBudget: 2400,
      historyTokenBudget: 1600,
      tools: [],
      gateDecision: null,
      messageCount: 2,
      systemMessageCount: 1,
    });

    expect(snapshot.verifier.verify_status).toBe('not_required');
    expect(snapshot.verifier.verify_required).toBe(false);
  });

  it('redacts sensitive patterns from snapshot fields', () => {
    const fakeKey = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');
    const snapshot = capturePromptSnapshot({
      trace_id: 'trace-snap-redact',
      tenant_id: 'default',
      chat_id: 'chat-snap-redact',
      model: 'gpt-4.1-mini',
      slotBreakdown: [],
      totalBudget: 4000,
      systemSlotBudget: 2400,
      historyTokenBudget: 1600,
      tools: [],
      gateDecision: makeGateDecision({
        status: 'failed',
        summary: `Failed with key ${fakeKey}`,
        failure_reasons: ['Bearer eyJhbGciOiJIUzI1NiJ9.test leaked'],
        missing_actions: ['Check password=s3cretValue in config'],
      }),
      messageCount: 4,
      systemMessageCount: 1,
    });

    const redacted = redactSnapshot(snapshot);
    expect(redacted.verifier.summary).toContain('[REDACTED]');
    expect(redacted.verifier.summary).not.toContain(fakeKey);
    expect(redacted.verifier.failure_reasons[0]).toContain('[REDACTED]');
    expect(redacted.verifier.failure_reasons[0]).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(redacted.verifier.missing_actions[0]).toContain('[REDACTED]');
  });

  it('persists and retrieves snapshots from the database', () => {
    resetTelemetryTableFlag();
    resetPromptSnapshotTableFlag();

    startTurnTrace({
      trace_id: traceId,
      turn_id: 'turn-snap-1',
      tenant_id: 'default',
      chat_id: 'chat-snap-1',
      model: 'gpt-4.1-mini',
      provider: 'openai',
    });

    const snapshot = capturePromptSnapshot({
      trace_id: traceId,
      tenant_id: 'default',
      chat_id: 'chat-snap-1',
      model: 'gpt-4.1-mini',
      slotBreakdown: makeSlotBreakdown(),
      totalBudget: 8000,
      systemSlotBudget: 4800,
      historyTokenBudget: 3200,
      tools: [{ name: 'read_file', source: 'builtin' }],
      gateDecision: makeGateDecision(),
      messageCount: 10,
      systemMessageCount: 2,
    });

    persistPromptSnapshot(snapshot);

    const retrieved = getPromptSnapshot(traceId, 'default');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.trace_id).toBe(traceId);
    expect(retrieved!.context.slots).toHaveLength(3);
    expect(retrieved!.tools).toHaveLength(1);
    expect(retrieved!.verifier.verify_status).toBe('passed');
  });

  it('updates the persisted verifier state after the Brain gate runs', () => {
    updatePromptSnapshotVerifier(traceId, 'default', makeGateDecision({
      status: 'failed',
      summary: 'Tests failed.',
      failure_reasons: ['2 tests failed'],
    }));

    const retrieved = getPromptSnapshot(traceId, 'default');
    expect(retrieved?.verifier).toMatchObject({
      verify_status: 'failed',
      summary: 'Tests failed.',
      failure_reasons: ['2 tests failed'],
    });
  });

  it('persists the runtime admission requirement and terminal outcome', () => {
    const admissionTraceId = 'trace-snap-admission';
    startTurnTrace({
      trace_id: admissionTraceId,
      turn_id: 'turn-snap-admission',
      tenant_id: 'default',
      chat_id: 'chat-snap-admission',
      model: 'deepseek-v4-pro',
    });
    persistPromptSnapshot(capturePromptSnapshot({
      trace_id: admissionTraceId,
      tenant_id: 'default',
      chat_id: 'chat-snap-admission',
      model: 'deepseek-v4-pro',
      slotBreakdown: [],
      totalBudget: 4000,
      systemSlotBudget: 2400,
      historyTokenBudget: 1600,
      tools: [
        { name: 'use_skill', source: 'builtin' },
        { name: 'decompose_task', source: 'builtin' },
      ],
      gateDecision: null,
      messageCount: 2,
      systemMessageCount: 1,
      runtimeAdmission: 'durable_plan',
    }));

    expect(getPromptSnapshot(admissionTraceId)?.runtime_meta.admission_status).toBe('required');
    updatePromptSnapshotAdmission(admissionTraceId, 'default', 'blocked');
    expect(getPromptSnapshot(admissionTraceId)?.runtime_meta).toMatchObject({
      runtime_admission: 'durable_plan',
      admission_status: 'blocked',
      exposed_tool_count: 2,
    });
  });

  it('lists recent snapshots for a tenant', () => {
    const snapshots = getRecentPromptSnapshots('default', 10);
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    expect(snapshots[0].tenant_id).toBe('default');
  });

  it('prunes old snapshots by age', async () => {
    // Insert a snapshot with an old timestamp, then prune
    const { getDb } = await import('../store/db.js');
    const db = getDb();
    db.prepare(`
      UPDATE prompt_snapshots SET captured_at = datetime('now', '-60 days')
      WHERE tenant_id = 'default'
    `).run();
    const deleted = pruneOldSnapshots('default', 30);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const remaining = getRecentPromptSnapshots('default', 10);
    expect(remaining).toHaveLength(0);
  });
});
