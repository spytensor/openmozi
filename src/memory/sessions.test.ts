import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createSession,
  getSession,
  listSessions,
  updateTitle,
  archiveSession,
  archiveUnusedDraftSessions,
  deleteSession,
  getReusableDraftSession,
  touchSession,
  getOrCreateSessionForChat,
  updateSessionWorkspaceContext,
  bindDraftSessionProject,
  getSessionActivity,
} from './sessions.js';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { saveMessage } from './conversations.js';
import { getWorkspaceDir } from '../tools/workspace-policy.js';
import { startTurnEnvelope, setTurnEnvelopeStatus } from './turn-envelopes.js';

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

describe('memory/sessions', () => {
  it('creates a session with correct fields', () => {
    const session = createSession('user1');
    expect(session.id).toMatch(/^sess-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(session.tenant_id).toBe('default');
    expect(session.user_id).toBe('user1');
    expect(session.title).toBe('New Chat');
    expect(session.archived).toBe(0);
    expect(session.message_count).toBe(0);
    expect(session.created_at).toMatch(/T.*Z$/);
    expect(session.updated_at).toMatch(/T.*Z$/);
  });

  it('creates a session with custom title', () => {
    const session = createSession('user1', 'My Project');
    expect(session.title).toBe('My Project');
  });

  it('preserves project ownership when updating execution scope after a conversation starts', () => {
    const session = createSession('project_user', 'Project Chat', 'default', {
      workspaceRootId: 'project',
      workspaceContext: {
        rootPath: '/Users/test/Mozi',
        rootKind: 'project_root',
        label: 'Runtime Source',
        gitBranch: 'main',
      },
    });

    expect(session.workspace_root_id).toBe('project');
    expect(session.workspace_context).toEqual({
      rootPath: '/Users/test/Mozi',
      rootKind: 'project_root',
      label: 'Runtime Source',
      gitBranch: 'main',
    });
    expect(session.project_root_id).toBe('project');
    expect(session.execution_root_id).toBe('project');

    saveMessage('project_user', 'user', 'start the project conversation', undefined, undefined, session.id);

    updateSessionWorkspaceContext(session.id, 'default', {
      workspaceRootId: null,
      workspaceContext: null,
    });

    const updated = getSession(session.id);
    expect(updated?.workspace_root_id).toBeNull();
    expect(updated?.workspace_context).toBeNull();
    expect(updated?.execution_root_id).toBeNull();
    expect(updated?.project_root_id).toBe('project');
    expect(updated?.project_context?.rootPath).toBe('/Users/test/Mozi');
  });

  it('moves an unused task to the project selected before its first message', () => {
    const session = createSession('draft_scope_user', 'New Chat', 'default', {
      workspaceRootId: 'project-root:/repo/a',
      workspaceContext: { rootPath: '/repo/a', rootKind: 'project_root', label: 'A' },
    });

    updateSessionWorkspaceContext(session.id, 'default', {
      workspaceRootId: 'project-root:/repo/b',
      workspaceContext: { rootPath: '/repo/b', rootKind: 'project_root', label: 'B' },
    });

    const updated = getSession(session.id)!;
    expect(updated.project_root_id).toBe('project-root:/repo/b');
    expect(updated.project_context?.rootPath).toBe('/repo/b');
    expect(updated.execution_root_id).toBe('project-root:/repo/b');
    expect(updated.execution_context?.rootPath).toBe('/repo/b');
  });

  it('binds an unused draft once without allowing execution scope to rewrite ownership', () => {
    const draft = createSession('binding_user');
    const project = {
      workspaceRootId: 'project-root:/repo/a',
      workspaceContext: { rootPath: '/repo/a', rootKind: 'project_root' as const, label: 'A' },
    };
    expect(bindDraftSessionProject(draft.id, 'default', project)).toBe(true);
    saveMessage('binding_user', 'user', 'first', undefined, undefined, draft.id);

    updateSessionWorkspaceContext(draft.id, 'default', {
      workspaceRootId: 'project-root:/repo/b',
      workspaceContext: { rootPath: '/repo/b', rootKind: 'project_root', label: 'B' },
    });
    const updated = getSession(draft.id)!;
    expect(updated.project_root_id).toBe('project-root:/repo/a');
    expect(updated.project_context?.rootPath).toBe('/repo/a');
    expect(updated.execution_root_id).toBe('project-root:/repo/b');
    expect(updated.execution_context?.rootPath).toBe('/repo/b');
    expect(bindDraftSessionProject(draft.id, 'default', project)).toBe(false);
  });

  it('restores Docker-era user workspace paths when sessions are read by the App', () => {
    const userId = 'legacy_workspace_user';
    const containerPath = `/data/workspace/users/${userId}/artifacts`;
    const session = createSession(userId, 'Legacy project', 'default', {
      workspaceRootId: containerPath,
      workspaceContext: {
        rootPath: containerPath,
        rootKind: 'project_root',
        label: 'artifacts',
      },
    });
    const restoredPath = `${getWorkspaceDir(userId)}/artifacts`;

    expect(session.workspace_context?.rootPath).toBe(restoredPath);
    expect(session.workspace_root_id).toBe(`project_root:${restoredPath}`);
  });

  it('gets a session by ID', () => {
    const created = createSession('user1');
    const fetched = getSession(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.user_id).toBe('user1');
  });

  it('returns null for unknown session', () => {
    expect(getSession('nonexistent')).toBeNull();
  });

  it('lists sessions for a user ordered by updated_at desc', () => {
    const db = getDb();
    const s1 = createSession('list_user', 'First');
    const s2 = createSession('list_user', 'Second');
    const s3 = createSession('list_user', 'Third');

    // Force distinct updated_at values since they may share the same second
    db.prepare(`UPDATE sessions SET updated_at = datetime('now', '-2 hours') WHERE id = ?`).run(s1.id);
    db.prepare(`UPDATE sessions SET updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(s2.id);
    db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(s3.id);

    const sessions = listSessions('list_user');
    expect(sessions.length).toBeGreaterThanOrEqual(3);
    // Most recently updated should be first
    const ids = sessions.map(s => s.id);
    expect(ids.indexOf(s3.id)).toBeLessThan(ids.indexOf(s2.id));
    expect(ids.indexOf(s2.id)).toBeLessThan(ids.indexOf(s1.id));
  });

  it('counts messages when listing sessions', () => {
    const session = createSession('message_count_user', 'Used Chat');
    saveMessage('chat-count', 'user', 'hello', undefined, undefined, session.id);

    const listed = listSessions('message_count_user').find(s => s.id === session.id);

    expect(listed?.message_count).toBe(1);
  });

  it('restores truthful aggregate activity and clears it only after every open turn is terminal', () => {
    const session = createSession('activity_user', 'Background work');
    startTurnEnvelope({ sessionId: session.id, chatId: 'activity_user', turnId: 'turn-user', origin: 'user', startedAt: 200 });
    startTurnEnvelope({ sessionId: session.id, chatId: 'activity_user', turnId: 'turn-bg', origin: 'background', startedAt: 100 });

    expect(getSessionActivity(session.id)).toEqual({ status: 'running', startedAt: 100 });
    expect(listSessions('activity_user').find((item) => item.id === session.id)).toMatchObject({
      activity_status: 'running',
      activity_started_at: 100,
    });

    setTurnEnvelopeStatus({ sessionId: session.id, turnId: 'turn-user', status: 'awaiting_approval' });
    expect(getSessionActivity(session.id)).toEqual({ status: 'awaiting_approval', startedAt: 100 });

    setTurnEnvelopeStatus({ sessionId: session.id, turnId: 'turn-user', status: 'completed' });
    expect(getSessionActivity(session.id)).toEqual({ status: 'running', startedAt: 100 });

    setTurnEnvelopeStatus({ sessionId: session.id, turnId: 'turn-bg', status: 'failed' });
    expect(getSessionActivity(session.id)).toEqual({ status: null, startedAt: null });
  });

  it('finds and prunes unused New Chat drafts', () => {
    const userId = 'draft_user';
    const older = createSession(userId);
    const newest = createSession(userId);
    const used = createSession(userId);
    saveMessage('draft-chat', 'user', 'used', undefined, undefined, used.id);

    const reusable = getReusableDraftSession(userId);
    expect(reusable?.id).toBe(newest.id);

    const archived = archiveUnusedDraftSessions(userId, 'default', newest.id);
    expect(archived).toBe(1);

    expect(getSession(older.id)?.archived).toBe(1);
    expect(getSession(newest.id)?.archived).toBe(0);
    expect(getSession(used.id)?.archived).toBe(0);
  });

  it('lists sessions with pagination', () => {
    const userId = 'paginate_user';
    for (let i = 0; i < 5; i++) {
      createSession(userId, `Page ${i}`);
    }

    const page1 = listSessions(userId, { limit: 2, offset: 0 });
    const page2 = listSessions(userId, { limit: 2, offset: 2 });
    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(2);
    expect(page1[0].id).not.toBe(page2[0].id);
  });

  it('updates session title', () => {
    const session = createSession('user1', 'Old Title');
    updateTitle(session.id, 'New Title');
    const updated = getSession(session.id);
    expect(updated!.title).toBe('New Title');
  });

  it('does not update a session title across tenant boundaries', () => {
    const session = createSession('user1', 'Tenant Scoped', 'tenant_title');
    updateTitle(session.id, 'Wrong Tenant Title', 'other_tenant');
    const updated = getSession(session.id, 'tenant_title');
    expect(updated!.title).toBe('Tenant Scoped');
  });

  it('archives a session', () => {
    const session = createSession('archive_user', 'To Archive');
    archiveSession(session.id);

    // Not returned in default listing
    const active = listSessions('archive_user');
    expect(active.find(s => s.id === session.id)).toBeUndefined();

    // Returned when includeArchived is true
    const all = listSessions('archive_user', { includeArchived: true });
    const archived = all.find(s => s.id === session.id);
    expect(archived).toBeDefined();
    expect(archived!.archived).toBe(1);
  });

  it('deletes a session permanently', () => {
    const session = createSession('user1', 'Delete Me');
    deleteSession(session.id);
    expect(getSession(session.id)).toBeNull();
  });

  it('touches a session to update updated_at', () => {
    const session = createSession('touch_user');

    // Set updated_at to 1 hour ago
    const db = getDb();
    db.prepare(`UPDATE sessions SET updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(session.id);
    const stale = getSession(session.id);
    const before = stale!.updated_at;

    touchSession(session.id);
    const after = getSession(session.id);
    expect(after!.updated_at).not.toBe(before);
  });

  it('does not touch a session across tenant boundaries', () => {
    const session = createSession('touch_user_scoped', 'Scoped', 'tenant_touch');

    const db = getDb();
    db.prepare(`UPDATE sessions SET updated_at = datetime('now', '-1 hour') WHERE id = ?`).run(session.id);
    const before = getSession(session.id, 'tenant_touch')!.updated_at;

    touchSession(session.id, 'other_tenant');
    const afterWrongTenant = getSession(session.id, 'tenant_touch')!.updated_at;
    expect(afterWrongTenant).toBe(before);

    touchSession(session.id, 'tenant_touch');
    const afterCorrectTenant = getSession(session.id, 'tenant_touch')!.updated_at;
    expect(afterCorrectTenant).not.toBe(before);
  });

  it('respects tenant_id isolation', () => {
    createSession('shared_user', 'Tenant A', 'tenant_a');
    createSession('shared_user', 'Tenant B', 'tenant_b');

    const listA = listSessions('shared_user', { tenantId: 'tenant_a' });
    const listB = listSessions('shared_user', { tenantId: 'tenant_b' });

    expect(listA).toHaveLength(1);
    expect(listA[0].title).toBe('Tenant A');
    expect(listB).toHaveLength(1);
    expect(listB[0].title).toBe('Tenant B');
  });

  it('getSession respects tenant_id', () => {
    const session = createSession('user1', 'Scoped', 'my_tenant');
    expect(getSession(session.id, 'my_tenant')).not.toBeNull();
    expect(getSession(session.id, 'other_tenant')).toBeNull();
  });

  describe('getOrCreateSessionForChat', () => {
    it('creates a new session when none exists', () => {
      const { session } = getOrCreateSessionForChat('chat_new', 'fresh_user');
      expect(session.id).toMatch(/^sess-/);
      expect(session.user_id).toBe('fresh_user');
    });

    it('reuses a recent session', () => {
      const userId = 'reuse_user';
      const first = createSession(userId, 'Existing');
      touchSession(first.id);

      const result = getOrCreateSessionForChat('chat_reuse', userId);
      expect(result.session.id).toBe(first.id);
      expect(result.staleSessionId).toBeUndefined();
    });

    it('creates a new session when the most recent is stale (>24h)', () => {
      const userId = 'stale_user';
      const old = createSession(userId, 'Old Session');

      // Make the session appear stale
      const db = getDb();
      db.prepare(`UPDATE sessions SET updated_at = datetime('now', '-25 hours') WHERE id = ?`).run(old.id);

      const result = getOrCreateSessionForChat('chat_stale', userId);
      expect(result.session.id).not.toBe(old.id);
      expect(result.staleSessionId).toBe(old.id);
    });

    it('does not reuse archived sessions', () => {
      const userId = 'archived_reuse_user';
      const session = createSession(userId, 'Archived');
      archiveSession(session.id);

      const result = getOrCreateSessionForChat('chat_archived', userId);
      expect(result.session.id).not.toBe(session.id);
    });
  });
});
