import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createSession } from './sessions.js';
import { getSessionHistory, saveMessage } from './conversations.js';
import { getLatestContextCheckpoint } from './context-checkpoints.js';
import { reduceSessionContext } from './conversation-context-reducer.js';
import { compress } from '../core/running-summary.js';

vi.mock('../core/running-summary.js', () => ({
  compress: vi.fn(async (messages: Array<{ content: string }>) => ({
    summary: `summary:${messages.map(message => message.content).join('|')}`,
    kept_turns: [], key_facts: [], summary_tokens: 10,
  })),
  mergeSummaries: vi.fn(async (existing: string, next: string) => [existing, next].filter(Boolean).join('\n')),
}));

describe('conversation context reducer', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = setupTestDb().tmpDir; });
  afterEach(() => teardownTestDb(tmpDir));

  function fixture() {
    const session = createSession('user-1', 'Long chat');
    for (let i = 0; i < 8; i++) saveMessage('user-1', i % 2 ? 'assistant' : 'user', `message-${i}-${'x'.repeat(120)}`, undefined, 0, session.id);
    const rows = getSessionHistory(session.id, 100);
    return {
      session,
      entries: rows.map(row => ({ stored: row, message: { role: row.role as 'user' | 'assistant', content: row.content } })),
    };
  }

  it('does not create a checkpoint while persisted history fits', async () => {
    const { session, entries } = fixture();
    const result = await reduceSessionContext({ tenantId: 'default', userId: 'user-1', sessionId: session.id, chatId: 'user-1', messages: entries, historyTokenBudget: 10_000, modelContextWindow: 20_000, threshold: 0.7 });
    expect(result.fallbackApplied).toBe('none');
    expect(getLatestContextCheckpoint(session.id)).toBeNull();
  });

  it('persists one completed checkpoint and reuses it on the next turn', async () => {
    const { session, entries } = fixture();
    await reduceSessionContext({ tenantId: 'default', userId: 'user-1', sessionId: session.id, chatId: 'user-1', messages: entries, historyTokenBudget: 180, modelContextWindow: 1000, threshold: 0.7 });
    const checkpoint = getLatestContextCheckpoint(session.id, 'default', 'completed');
    expect(checkpoint?.summary).toContain('summary:message-0');
    expect(checkpoint?.source_message_id).toBeGreaterThan(0);

    saveMessage('user-1', 'user', 'new tail', undefined, 0, session.id);
    const rows = getSessionHistory(session.id, 100);
    const result = await reduceSessionContext({ tenantId: 'default', userId: 'user-1', sessionId: session.id, chatId: 'user-1', messages: rows.map(row => ({ stored: row, message: { role: row.role as 'user' | 'assistant', content: row.content } })), historyTokenBudget: 1000, modelContextWindow: 1000, threshold: 0.7 });
    expect(result.messages[0].content).toContain('[Conversation Summary]');
    expect(result.messages.at(-1)?.content).toBe('new tail');
  });

  it('marks failed reductions and falls back without deleting raw history', async () => {
    const { session, entries } = fixture();
    vi.mocked(compress).mockRejectedValueOnce(new Error('summary unavailable'));
    const result = await reduceSessionContext({ tenantId: 'default', userId: 'user-1', sessionId: session.id, chatId: 'user-1', messages: entries, historyTokenBudget: 180, modelContextWindow: 1000, threshold: 0.7 });
    expect(getLatestContextCheckpoint(session.id)?.status).toBe('failed');
    expect(getSessionHistory(session.id, 100)).toHaveLength(8);
    expect(result.messages.length).toBeGreaterThan(0);
  });
});
