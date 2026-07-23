/**
 * Tests for per-user workspace directories (#240)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import {
  ensureUserWorkspace,
  getUserWorkspacePath,
  cleanupUserWorkspace,
  getWorkspacesBase,
} from './workspace.js';

let tmpBase: string;

beforeEach(() => {
  tmpBase = mkdtempSync(join(tmpdir(), 'mozi-ws-'));
  process.env.MOZI_WORKSPACES = tmpBase;
});

afterEach(() => {
  delete process.env.MOZI_WORKSPACES;
  rmSync(tmpBase, { recursive: true, force: true });
});

describe('getWorkspacesBase()', () => {
  it('returns MOZI_WORKSPACES env when set', () => {
    expect(getWorkspacesBase()).toBe(tmpBase);
  });

  it('falls back to ~/.mozi/workspace/users', () => {
    delete process.env.MOZI_WORKSPACES;
    const savedMoziHome = process.env.MOZI_HOME;
    delete process.env.MOZI_HOME;
    try {
      const base = getWorkspacesBase();
      expect(base).toContain('.mozi/workspace/users');
    } finally {
      if (savedMoziHome === undefined) {
        delete process.env.MOZI_HOME;
      } else {
        process.env.MOZI_HOME = savedMoziHome;
      }
    }
  });
});

describe('getUserWorkspacePath()', () => {
  it('returns path under base', () => {
    const p = getUserWorkspacePath('user-123');
    expect(p).toBe(join(tmpBase, 'user-123'));
  });

  it('rejects path traversal with ..', () => {
    expect(() => getUserWorkspacePath('../evil')).toThrow();
  });

  it('rejects slashes in userId', () => {
    expect(() => getUserWorkspacePath('a/b')).toThrow();
  });

  it('rejects empty userId', () => {
    expect(() => getUserWorkspacePath('')).toThrow();
  });
});

describe('ensureUserWorkspace()', () => {
  it('creates directory and returns path', async () => {
    const p = await ensureUserWorkspace('user-abc');
    expect(p).toBe(join(tmpBase, 'user-abc'));
    const st = statSync(p);
    expect(st.isDirectory()).toBe(true);
  });

  it('sets permissions 0700', async () => {
    const p = await ensureUserWorkspace('user-perms');
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('is idempotent', async () => {
    await ensureUserWorkspace('user-idem');
    await expect(ensureUserWorkspace('user-idem')).resolves.toBeDefined();
  });

  it('rejects path traversal', async () => {
    await expect(ensureUserWorkspace('../../root')).rejects.toThrow();
  });
});

describe('cleanupUserWorkspace()', () => {
  it('removes existing workspace and returns true', async () => {
    await ensureUserWorkspace('user-del');
    const result = cleanupUserWorkspace('user-del');
    expect(result).toBe(true);
    expect(() => statSync(join(tmpBase, 'user-del'))).toThrow();
  });

  it('returns false when workspace does not exist', () => {
    const result = cleanupUserWorkspace('user-nonexistent');
    expect(result).toBe(false);
  });
});
