import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { write, read, list, remove, cleanup } from './blackboard.js';
import { getDb } from '../store/db.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('capabilities/blackboard', () => {
  describe('write and read', () => {
    it('round-trips a value', () => {
      write('test_key', 'test_value', { scope: 'global', tenant_id: 'default' });
      const value = read('test_key', { scope: 'global', tenant_id: 'default' });
      expect(value).toBe('test_value');
    });

    it('upserts existing key', () => {
      write('upsert_key', 'old_value');
      write('upsert_key', 'new_value');
      expect(read('upsert_key')).toBe('new_value');
    });

    it('returns null for missing key', () => {
      expect(read('nonexistent_key')).toBeNull();
    });
  });

  describe('scope isolation', () => {
    it('isolates by scope', () => {
      write('shared_key', 'global_val', { scope: 'global' });
      write('shared_key', 'task_val', { scope: 'task:t1' });

      expect(read('shared_key', { scope: 'global' })).toBe('global_val');
      expect(read('shared_key', { scope: 'task:t1' })).toBe('task_val');
    });

    it('isolates by tenant', () => {
      write('tenant_key', 'val_a', { tenant_id: 'tenant_a' });
      write('tenant_key', 'val_b', { tenant_id: 'tenant_b' });

      expect(read('tenant_key', { tenant_id: 'tenant_a' })).toBe('val_a');
      expect(read('tenant_key', { tenant_id: 'tenant_b' })).toBe('val_b');
    });
  });

  describe('list', () => {
    it('returns all entries in scope', () => {
      write('list_a', 'va', { scope: 'task:list_test' });
      write('list_b', 'vb', { scope: 'task:list_test' });

      const entries = list({ scope: 'task:list_test' });
      expect(entries.length).toBe(2);
      expect(entries.map(e => e.key).sort()).toEqual(['list_a', 'list_b']);
    });
  });

  describe('remove', () => {
    it('deletes an entry', () => {
      write('remove_me', 'val');
      expect(remove('remove_me')).toBe(true);
      expect(read('remove_me')).toBeNull();
    });

    it('returns false for missing key', () => {
      expect(remove('never_existed')).toBe(false);
    });
  });

  describe('written_by tracking', () => {
    it('stores and retrieves author', () => {
      write('authored_key', 'val', { written_by: 'agent-007' });
      const entries = list();
      const entry = entries.find(e => e.key === 'authored_key');
      expect(entry?.written_by).toBe('agent-007');
    });
  });

  describe('TTL expiration', () => {
    it('read returns null for expired entry', () => {
      write('ttl_key', 'ttl_val', { scope: 'task:ttl_test', ttl_seconds: 60 });
      // Verify it's readable before expiration
      expect(read('ttl_key', { scope: 'task:ttl_test' })).toBe('ttl_val');

      // Backdate created_at to simulate expiration
      const db = getDb();
      db.prepare(
        `UPDATE blackboard SET created_at = datetime('now', '-120 seconds')
         WHERE key = ? AND scope = ?`,
      ).run('ttl_key', 'task:ttl_test');

      // Now read should return null (expired)
      expect(read('ttl_key', { scope: 'task:ttl_test' })).toBeNull();
    });

    it('list filters out expired entries', () => {
      write('ttl_fresh', 'fresh_val', { scope: 'task:ttl_list', ttl_seconds: 3600 });
      write('ttl_stale', 'stale_val', { scope: 'task:ttl_list', ttl_seconds: 60 });
      write('ttl_none', 'no_ttl_val', { scope: 'task:ttl_list' });

      // Backdate the stale entry
      const db = getDb();
      db.prepare(
        `UPDATE blackboard SET created_at = datetime('now', '-120 seconds')
         WHERE key = ? AND scope = ?`,
      ).run('ttl_stale', 'task:ttl_list');

      const entries = list({ scope: 'task:ttl_list' });
      const keys = entries.map(e => e.key).sort();
      expect(keys).toEqual(['ttl_fresh', 'ttl_none']);
      expect(keys).not.toContain('ttl_stale');
    });
  });
});
