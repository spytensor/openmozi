import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { getFactsByUser } from './long-term.js';
import { applyMemoryMutation, getMemoryTurnUpdates } from './mutations.js';

let tmpDir: string;

beforeAll(() => {
  const setup = setupTestDb();
  tmpDir = setup.tmpDir;
});

afterAll(() => teardownTestDb(tmpDir));

describe('memory mutation contract', () => {
  it('counts explicit remember and auto-extract only once in the same turn', () => {
    const first = applyMemoryMutation({
      chatId: 'chat-same-turn',
      tenantId: 'tenant-same-turn',
      userId: 'user-same-turn',
      turnId: 'turn-same-turn',
      category: 'preference',
      key: 'data_first',
      value: 'Always verify data before drawing conclusions.',
      source: 'tool',
    });
    const second = applyMemoryMutation({
      chatId: 'chat-same-turn',
      tenantId: 'tenant-same-turn',
      userId: 'user-same-turn',
      turnId: 'turn-same-turn',
      category: 'decision',
      key: 'verification_rule',
      value: 'The user requires data verification before conclusions.',
      source: 'auto_extract',
      requestedAction: 'REINFORCE',
      targetFactId: first.fact.id,
    });

    expect(first.action).toBe('ADD');
    expect(second.action).toBe('NOOP');
    expect(getFactsByUser('user-same-turn', 'tenant-same-turn')).toHaveLength(1);
    expect(getMemoryTurnUpdates('turn-same-turn', 'tenant-same-turn')).toEqual([
      { factId: first.fact.id, action: 'ADD', category: 'preference' },
    ]);
  });

  it('reinforces a paraphrased memory in a later turn without adding a row', () => {
    const original = applyMemoryMutation({
      chatId: 'chat-reinforce-a', tenantId: 'tenant-reinforce', userId: 'user-reinforce', turnId: 'turn-a',
      category: 'preference', key: 'answer_style', value: 'Give concise answers.', source: 'auto_extract',
    });
    const reinforced = applyMemoryMutation({
      chatId: 'chat-reinforce-b', tenantId: 'tenant-reinforce', userId: 'user-reinforce', turnId: 'turn-b',
      category: 'preference', key: 'response_length', value: 'The user again asked for brief responses.', source: 'auto_extract',
      requestedAction: 'REINFORCE', targetFactId: original.fact.id,
    });

    expect(reinforced.action).toBe('REINFORCE');
    expect(reinforced.fact.id).toBe(original.fact.id);
    expect(reinforced.fact.salience_score).toBeGreaterThan(original.fact.salience_score);
    expect(getFactsByUser('user-reinforce', 'tenant-reinforce')).toHaveLength(1);
  });

  it('updates a corrected memory while preserving its stable identity', () => {
    const original = applyMemoryMutation({
      chatId: 'chat-update', tenantId: 'tenant-update', userId: 'user-update', turnId: 'turn-old',
      category: 'fact', key: 'timezone', value: 'The user is in UTC+4.', source: 'auto_extract',
    });
    const updated = applyMemoryMutation({
      chatId: 'chat-update', tenantId: 'tenant-update', userId: 'user-update', turnId: 'turn-new',
      category: 'fact', key: 'current_timezone', value: 'The user moved to UTC+8.', source: 'auto_extract_correction',
      requestedAction: 'UPDATE', targetFactId: original.fact.id,
    });

    expect(updated.action).toBe('UPDATE');
    expect(updated.fact.id).toBe(original.fact.id);
    expect(updated.fact.key).toBe('timezone');
    expect(updated.fact.value).toBe('The user moved to UTC+8.');
    expect(getFactsByUser('user-update', 'tenant-update')).toHaveLength(1);
  });

  it('treats a changed value under the same canonical key as an update', () => {
    const original = applyMemoryMutation({
      chatId: 'chat-key-update', tenantId: 'tenant-key-update', userId: 'user-key-update', turnId: 'turn-key-old',
      category: 'preference', key: 'theme', value: 'Use dark mode.', source: 'tool',
    });
    const updated = applyMemoryMutation({
      chatId: 'chat-key-update', tenantId: 'tenant-key-update', userId: 'user-key-update', turnId: 'turn-key-new',
      category: 'preference', key: 'theme', value: 'Use light mode.', source: 'tool',
    });

    expect(updated.action).toBe('UPDATE');
    expect(updated.fact.id).toBe(original.fact.id);
    expect(updated.fact.value).toBe('Use light mode.');
    expect(updated.fact.source).toBe('tool');
    expect(getFactsByUser('user-key-update', 'tenant-key-update')).toHaveLength(1);
  });

  it('does not merge equal keys across different users', () => {
    const first = applyMemoryMutation({
      chatId: 'chat-user-a', tenantId: 'tenant-users', userId: 'user-a', turnId: 'turn-user-a',
      category: 'preference', key: 'theme', value: 'Use dark mode.', source: 'manual',
    });
    const second = applyMemoryMutation({
      chatId: 'chat-user-b', tenantId: 'tenant-users', userId: 'user-b', turnId: 'turn-user-b',
      category: 'preference', key: 'theme', value: 'Use light mode.', source: 'manual',
    });

    expect(first.action).toBe('ADD');
    expect(second.action).toBe('ADD');
    expect(first.fact.id).not.toBe(second.fact.id);
  });

  it('does not merge Chinese facts merely because their values share one Han character', () => {
    const first = applyMemoryMutation({
      chatId: 'chat-cjk-mutation', tenantId: 'tenant-cjk-mutation', userId: 'user-cjk-mutation', turnId: 'turn-cjk-a',
      category: 'fact', key: 'report_process', value: '报告格式已经确认', source: 'auto_extract',
    });
    const second = applyMemoryMutation({
      chatId: 'chat-cjk-mutation', tenantId: 'tenant-cjk-mutation', userId: 'user-cjk-mutation', turnId: 'turn-cjk-b',
      category: 'fact', key: 'tax_process', value: '报税材料已经确认', source: 'auto_extract',
    });

    expect(first.action).toBe('ADD');
    expect(second.action).toBe('ADD');
    expect(second.fact.id).not.toBe(first.fact.id);
    expect(getFactsByUser('user-cjk-mutation', 'tenant-cjk-mutation')).toHaveLength(2);
  });

  it('records immutable value and provenance snapshots for project-memory evidence', () => {
    const result = applyMemoryMutation({
      chatId: '__project__', tenantId: 'tenant-evidence', userId: 'user-evidence', turnId: 'turn-evidence',
      category: 'decision', key: 'database', value: 'The project uses SQLite.', source: 'project_user_assertion',
      status: 'active', originKind: 'user', candidateScope: 'chat',
    });
    expect(getDb().prepare(`
      SELECT value_snapshot, status_snapshot, origin_kind,
             previous_value_snapshot, previous_status_snapshot, previous_origin_kind, previous_source
      FROM memory_fact_evidence WHERE fact_id = ?
    `).get(result.fact.id)).toEqual({
      value_snapshot: 'The project uses SQLite.',
      status_snapshot: 'active',
      origin_kind: 'user',
      previous_value_snapshot: null,
      previous_status_snapshot: null,
      previous_origin_kind: null,
      previous_source: null,
    });
  });

  it('records the pre-change value and provenance on updates', () => {
    const original = applyMemoryMutation({
      chatId: '__project__:reviewer', tenantId: 'tenant-history', userId: 'reviewer', turnId: 'turn-original-history',
      category: 'fact', key: 'runtime', value: 'Assistant guessed Express.', source: 'project_extraction',
      status: 'pending_review', originKind: 'assistant', candidateScope: 'chat',
    });
    applyMemoryMutation({
      chatId: '__project__:reviewer', tenantId: 'tenant-history', userId: 'reviewer', turnId: 'turn-edit-history',
      category: 'fact', key: 'runtime', value: 'User confirmed Fastify.', source: 'user_edit',
      requestedAction: 'UPDATE', targetFactId: original.fact.id,
      status: 'pending_review', originKind: 'assistant', candidateScope: 'chat',
    });

    expect(getDb().prepare(`
      SELECT previous_value_snapshot, previous_status_snapshot, previous_origin_kind, previous_source
      FROM memory_fact_evidence WHERE fact_id = ? AND turn_id = 'turn-edit-history'
    `).get(original.fact.id)).toEqual({
      previous_value_snapshot: 'Assistant guessed Express.',
      previous_status_snapshot: 'pending_review',
      previous_origin_kind: 'assistant',
      previous_source: 'project_extraction',
    });
  });
});
