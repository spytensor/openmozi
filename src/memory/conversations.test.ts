import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { clearHistory, deleteSessionMessage, getHistory, getSessionHistory, saveMessage } from './conversations.js';
import { createSession } from './sessions.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('memory/conversations', () => {
  it('saves and retrieves messages', () => {
    saveMessage('chat_1', 'user', 'Hello');
    saveMessage('chat_1', 'assistant', 'Hi there!', 'gpt-4.1-mini', 50);

    const history = getHistory('chat_1');
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('Hello');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Hi there!');
    expect(history[1].model).toBe('gpt-4.1-mini');
    expect(history[1].tokens_used).toBe(50);
  });

  it('returns messages in chronological order', () => {
    saveMessage('chat_order', 'user', 'First');
    saveMessage('chat_order', 'assistant', 'Second');
    saveMessage('chat_order', 'user', 'Third');

    const history = getHistory('chat_order');
    expect(history.map(m => m.content)).toEqual(['First', 'Second', 'Third']);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      saveMessage('chat_limit', 'user', `Message ${i}`);
    }

    const history = getHistory('chat_limit', 5);
    expect(history).toHaveLength(5);
    // Should get the 5 most recent messages
    expect(history[4].content).toBe('Message 9');
  });

  it('isolates chats by chat_id', () => {
    saveMessage('chat_A', 'user', 'From A');
    saveMessage('chat_B', 'user', 'From B');

    const historyA = getHistory('chat_A');
    const historyB = getHistory('chat_B');

    expect(historyA.every(m => m.chat_id === 'chat_A')).toBe(true);
    expect(historyB.every(m => m.chat_id === 'chat_B')).toBe(true);
  });

  it('clears history for a chat', () => {
    saveMessage('chat_clear', 'user', 'To be deleted');
    saveMessage('chat_clear', 'assistant', 'Also deleted');

    clearHistory('chat_clear');
    const history = getHistory('chat_clear');
    expect(history).toHaveLength(0);
  });

  it('clear does not affect other chats', () => {
    saveMessage('chat_keep', 'user', 'Keep me');
    saveMessage('chat_delete', 'user', 'Delete me');

    clearHistory('chat_delete');

    expect(getHistory('chat_keep').length).toBeGreaterThan(0);
    expect(getHistory('chat_delete')).toHaveLength(0);
  });

  it('respects tenant_id isolation', () => {
    saveMessage('chat_tenant', 'user', 'Tenant A msg', undefined, undefined, undefined, 'tenant_A');
    saveMessage('chat_tenant', 'user', 'Tenant B msg', undefined, undefined, undefined, 'tenant_B');

    const historyA = getHistory('chat_tenant', 20, 'tenant_A');
    const historyB = getHistory('chat_tenant', 20, 'tenant_B');

    expect(historyA).toHaveLength(1);
    expect(historyA[0].content).toBe('Tenant A msg');
    expect(historyB).toHaveLength(1);
    expect(historyB[0].content).toBe('Tenant B msg');
  });

  it('returns empty array for unknown chat', () => {
    const history = getHistory('nonexistent_chat');
    expect(history).toEqual([]);
  });

  it('stores null model when not provided', () => {
    saveMessage('chat_null_model', 'user', 'No model');
    const history = getHistory('chat_null_model');
    expect(history[0].model).toBeNull();
    expect(history[0].tokens_used).toBe(0);
  });

  it('deletes a user prompt as its complete turn without removing later context', () => {
    const session = createSession('user-1', 'Delete turn');
    const firstPrompt = saveMessage('chat-1', 'user', 'First prompt', undefined, undefined, session.id);
    saveMessage('chat-1', 'assistant', 'First answer', undefined, undefined, session.id);
    saveMessage('chat-1', 'tool', 'First tool output', undefined, undefined, session.id);
    saveMessage('chat-1', 'user', 'Second prompt', undefined, undefined, session.id);
    saveMessage('chat-1', 'assistant', 'Second answer', undefined, undefined, session.id);

    expect(deleteSessionMessage(session.id, firstPrompt)).toMatchObject({
      role: 'user',
      deleted_conversation_count: 3,
    });
    expect(getSessionHistory(session.id).map(message => message.content)).toEqual([
      'Second prompt',
      'Second answer',
    ]);
  });

  it('deletes only the requested assistant response', () => {
    const session = createSession('user-1', 'Delete response');
    saveMessage('chat-1', 'user', 'Prompt', undefined, undefined, session.id);
    const answer = saveMessage('chat-1', 'assistant', 'Answer', undefined, undefined, session.id);
    saveMessage('chat-1', 'assistant', 'Follow-up', undefined, undefined, session.id);

    expect(deleteSessionMessage(session.id, answer)).toMatchObject({
      role: 'assistant',
      deleted_conversation_count: 1,
    });
    expect(getSessionHistory(session.id).map(message => message.content)).toEqual(['Prompt', 'Follow-up']);
  });
});
