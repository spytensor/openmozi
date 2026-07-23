import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerApiRoutes, revealCommandForPlatform } from './application-routes.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { ensureToolWorkspaceDir } from '../tools/workspace-policy.js';
import { LOCAL_USER_ID } from '../security/users.js';
import { createSession } from '../memory/sessions.js';
import { saveTimelineItem } from '../memory/session-timeline.js';
import { getDb } from '../store/db.js';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: childProcessMocks.execFile }));

const config = {
  server: { auth_mode: 'none' as const },
  security: { enterprise: {} },
  http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
};

describe('filesystem reveal and source routes', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let workspace: string;
  let savedMoziHome: string | undefined;

  beforeEach(async () => {
    ({ tmpDir } = setupTestDb());
    savedMoziHome = process.env.MOZI_HOME;
    process.env.MOZI_HOME = join(tmpDir, 'home');
    workspace = await ensureToolWorkspaceDir(LOCAL_USER_ID);
    app = Fastify();
    childProcessMocks.execFile.mockReset();
    childProcessMocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, '', ''));
    await registerApiRoutes(app, { jwtSecret: 'test-secret', config });
  });

  afterEach(async () => {
    await app.close();
    teardownTestDb(tmpDir);
    if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = savedMoziHome;
  });

  it('reveals a workspace file with an argument array and five-second timeout', async () => {
    const path = join(workspace, 'report.pdf');
    writeFileSync(path, 'report');
    const response = await app.inject({ method: 'POST', url: '/api/fs/reveal', payload: { path } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ success: true });
    expect(childProcessMocks.execFile).toHaveBeenCalledWith(
      expect.any(String), expect.any(Array), { timeout: 5_000 }, expect.any(Function),
    );
  });

  it('rejects traversal and a symlink escaping the workspace', async () => {
    const outside = join(tmpDir, 'outside.txt');
    writeFileSync(outside, 'private');
    const link = join(workspace, 'escape.txt');
    symlinkSync(outside, link);

    const traversal = await app.inject({ method: 'POST', url: '/api/fs/reveal', payload: { path: join(workspace, '..', 'outside.txt') } });
    const symlink = await app.inject({ method: 'POST', url: '/api/fs/reveal', payload: { path: link } });
    expect(traversal.statusCode).toBe(400);
    expect(symlink.statusCode).toBe(400);
    expect(childProcessMocks.execFile).not.toHaveBeenCalled();
  });

  it('uses the containing folder for the non-darwin fallback without shell interpolation', () => {
    expect(revealCommandForPlatform('linux', '/workspace/reports/final.pdf', false)).toEqual({
      command: 'xdg-open', args: ['/workspace/reports'], revealed: 'folder',
    });
    expect(revealCommandForPlatform('win32', 'C:\\workspace\\final.pdf', false)).toEqual({
      command: 'explorer.exe', args: ['/select,', 'C:\\workspace\\final.pdf'], revealed: 'folder',
    });
  });

  it('resolves the newest matching file_v1 artifact to its source session', async () => {
    const path = join(workspace, 'deliverable.docx');
    writeFileSync(path, 'document');
    const session = createSession(LOCAL_USER_ID, 'Quarterly report');
    saveTimelineItem({
      sessionId: session.id, chatId: 'local-user', type: 'artifact', eventKey: 'artifact:file', timestamp: 1234,
      data: { plugin_id: 'file_v1', status: 'completed', data: { path, filename: 'deliverable.docx' } },
    });

    const response = await app.inject({ method: 'GET', url: `/api/fs/source?path=${encodeURIComponent(path)}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ source: { sessionId: session.id, sessionTitle: 'Quarterly report', timestamp: 1234 } });
  });

  it('returns null for missing artifacts and sessions that no longer exist', async () => {
    const missingPath = join(workspace, 'missing-source.txt');
    writeFileSync(missingPath, 'plain');
    expect((await app.inject({ method: 'GET', url: `/api/fs/source?path=${encodeURIComponent(missingPath)}` })).json()).toEqual({ source: null });

    const path = join(workspace, 'dead-session.txt');
    writeFileSync(path, 'plain');
    const session = createSession(LOCAL_USER_ID, 'Deleted chat');
    saveTimelineItem({
      sessionId: session.id, chatId: 'local-user', type: 'artifact', eventKey: 'artifact:dead', timestamp: 2345,
      data: { plugin_id: 'file_v1', data: { path, filename: 'dead-session.txt' } },
    });
    const db = getDb();
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
    db.pragma('foreign_keys = ON');

    const response = await app.inject({ method: 'GET', url: `/api/fs/source?path=${encodeURIComponent(path)}` });
    expect(response.json()).toEqual({ source: null });
  });

  it('rejects source lookup through a symlink outside the workspace', async () => {
    const outside = join(tmpDir, 'outside-source.txt');
    writeFileSync(outside, 'private');
    const link = join(workspace, 'outside-source.txt');
    symlinkSync(outside, link);
    const response = await app.inject({ method: 'GET', url: `/api/fs/source?path=${encodeURIComponent(link)}` });
    expect(response.statusCode).toBe(400);
  });
});
