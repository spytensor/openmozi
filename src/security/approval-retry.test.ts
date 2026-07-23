import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  savePendingRetry,
  consumePendingRetry,
  cleanExpiredRetries,
  resetTableFlag,
} from './approval-retry.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  resetTableFlag();
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('security/approval-retry', () => {
  describe('savePendingRetry + consumePendingRetry round-trip', () => {
    it('saves and retrieves retry context', () => {
      savePendingRetry({
        approvalRequestId: 'req-001',
        tenantId: 'default',
        chatId: 'chat-123',
        toolName: 'shell_exec',
        toolArgs: { command: 'rm -rf /tmp/test' },
        toolCallId: 'tc-001',
        sessionId: 'session-abc',
      });

      const ctx = consumePendingRetry('req-001');
      expect(ctx).not.toBeNull();
      expect(ctx!.approvalRequestId).toBe('req-001');
      expect(ctx!.tenantId).toBe('default');
      expect(ctx!.chatId).toBe('chat-123');
      expect(ctx!.toolName).toBe('shell_exec');
      expect(ctx!.toolArgs).toEqual({ command: 'rm -rf /tmp/test' });
      expect(ctx!.toolCallId).toBe('tc-001');
      expect(ctx!.sessionId).toBe('session-abc');
    });

    it('consume deletes the entry (second consume returns null)', () => {
      savePendingRetry({
        approvalRequestId: 'req-002',
        tenantId: 'default',
        chatId: 'chat-456',
        toolName: 'shell_exec',
        toolArgs: { command: 'echo hello' },
        toolCallId: 'tc-002',
      });

      const first = consumePendingRetry('req-002');
      expect(first).not.toBeNull();

      const second = consumePendingRetry('req-002');
      expect(second).toBeNull();
    });
  });

  describe('consumePendingRetry', () => {
    it('returns null for unknown approval request ID', () => {
      const result = consumePendingRetry('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  describe('cleanExpiredRetries', () => {
    it('removes entries older than TTL', () => {
      // Insert an entry with a manually backdated created_at
      const db = getDb();
      db.prepare(`
        INSERT OR REPLACE INTO approval_retry_queue
          (approval_request_id, tenant_id, chat_id, tool_name, tool_args, tool_call_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-60 minutes'))
      `).run('req-old', 'default', 'chat-old', 'shell_exec', '{"command":"old"}', 'tc-old');

      // Insert a fresh entry
      savePendingRetry({
        approvalRequestId: 'req-fresh',
        tenantId: 'default',
        chatId: 'chat-fresh',
        toolName: 'shell_exec',
        toolArgs: { command: 'fresh' },
        toolCallId: 'tc-fresh',
      });

      const deleted = cleanExpiredRetries(30);
      expect(deleted).toBeGreaterThanOrEqual(1);

      // Old entry should be gone
      expect(consumePendingRetry('req-old')).toBeNull();

      // Fresh entry should still exist
      const fresh = consumePendingRetry('req-fresh');
      expect(fresh).not.toBeNull();
      expect(fresh!.toolArgs).toEqual({ command: 'fresh' });
    });
  });
});
