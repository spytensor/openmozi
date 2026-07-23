import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { closeDb, getDb } from '../store/db.js';
import { runMigrations } from '../store/migrate.js';
import { exec } from '../capabilities/shell.js';
import { registerGitBranchRoutes } from './git-branch-routes.js';

let dbDir = '';
let repoDir = '';

async function gitInit(dir: string): Promise<void> {
  await exec('git init', { cwd: dir, timeout: 10_000 });
  await exec('git config user.email "test@mozi.dev"', { cwd: dir, timeout: 10_000 });
  await exec('git config user.name "Test"', { cwd: dir, timeout: 10_000 });
}

function appFor(options?: { authed?: boolean; allowed?: boolean; runtimeSource?: boolean }) {
  const { authed = true, allowed = true, runtimeSource = false } = options ?? {};
  const app = Fastify();
  if (authed) {
    app.addHook('preHandler', async (request) => {
      (request as unknown as { tenantContext: { tenant_id: string; user_id: string; roles: string[] } }).tenantContext = {
        tenant_id: 'tenant-a',
        user_id: 'user-a',
        roles: ['viewer'],
      };
    });
  }
  registerGitBranchRoutes(app, {
    resolveAllowedDir: (path) => (allowed ? path : null),
    isRuntimeSourceRoot: () => runtimeSource,
  });
  return app;
}

beforeEach(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'mozi-git-routes-db-'));
  runMigrations(join(dbDir, 'test.db'));
  repoDir = mkdtempSync(join(tmpdir(), 'mozi-git-routes-repo-'));
  await gitInit(repoDir);
  writeFileSync(join(repoDir, 'base.txt'), 'base');
  await exec('git add . && git commit -m "init"', { cwd: repoDir, timeout: 10_000 });
});

afterEach(() => {
  closeDb();
  rmSync(dbDir, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

describe('git branch routes', () => {
  it('rejects unauthenticated requests', async () => {
    const app = appFor({ authed: false });
    const res = await app.inject({ method: 'GET', url: `/api/git/branches?root=${encodeURIComponent(repoDir)}` });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a missing root query', async () => {
    const app = appFor();
    const res = await app.inject({ method: 'GET', url: '/api/git/branches' });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a non-granted root without disclosing why', async () => {
    const app = appFor({ allowed: false });
    const res = await app.inject({ method: 'GET', url: '/api/git/branches?root=/etc' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('Not found');
  });

  it('lists branches for a granted repo', async () => {
    const app = appFor();
    const res = await app.inject({ method: 'GET', url: `/api/git/branches?root=${encodeURIComponent(repoDir)}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.current.branch).toBeTruthy();
    expect(body.is_runtime_source).toBe(false);
    expect(body.branches.length).toBe(1);
    expect(body.branches[0].is_current).toBe(true);
  });

  it('flags the runtime source root', async () => {
    const app = appFor({ runtimeSource: true });
    const res = await app.inject({ method: 'GET', url: `/api/git/branches?root=${encodeURIComponent(repoDir)}` });
    expect(res.json().is_runtime_source).toBe(true);
  });

  it('returns 409 with git stderr for a non-repo directory', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'mozi-notgit-'));
    try {
      const app = appFor();
      const res = await app.inject({ method: 'GET', url: `/api/git/branches?root=${encodeURIComponent(bare)}` });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/not a git repository/i);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('rejects an extra body field (strict schema)', async () => {
    const app = appFor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/switch',
      payload: { root: repoDir, branch: 'x', force: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid branch name with 400 (git never runs)', async () => {
    const app = appFor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/switch',
      payload: { root: repoDir, branch: '-f' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid branch name/);
  });

  it('switches branches and writes an audit row', async () => {
    await exec('git branch feature', { cwd: repoDir, timeout: 10_000 });
    const app = appFor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/switch',
      payload: { root: repoDir, branch: 'feature' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branch).toBe('feature');
    expect(['main', 'master']).toContain(body.previous);

    const head = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, timeout: 10_000 });
    expect(head.stdout.trim()).toBe('feature');

    const audit = getDb()
      .prepare("SELECT * FROM audit_log WHERE action = 'git.branch_switch'")
      .all() as Array<{ resource_id: string; user_id: string }>;
    expect(audit.length).toBe(1);
    expect(audit[0].user_id).toBe('user-a');
  });

  it('creates a branch with create: true', async () => {
    const app = appFor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/switch',
      payload: { root: repoDir, branch: 'feature/new', create: true },
    });
    expect(res.statusCode).toBe(200);
    const head = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, timeout: 10_000 });
    expect(head.stdout.trim()).toBe('feature/new');
  });

  it('returns 409 with verbatim stderr when git aborts on conflict', async () => {
    await exec('git switch -c b', { cwd: repoDir, timeout: 10_000 });
    writeFileSync(join(repoDir, 'base.txt'), 'b content');
    await exec('git add . && git commit -m "b"', { cwd: repoDir, timeout: 10_000 });
    await exec('git switch -', { cwd: repoDir, timeout: 10_000 });
    writeFileSync(join(repoDir, 'base.txt'), 'dirty conflicting');

    const app = appFor();
    const res = await app.inject({
      method: 'POST',
      url: '/api/git/switch',
      payload: { root: repoDir, branch: 'b' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/overwritten|checkout/i);
    // Tree untouched.
    const head = await exec('git rev-parse --abbrev-ref HEAD', { cwd: repoDir, timeout: 10_000 });
    expect(head.stdout.trim()).not.toBe('b');
  });
});
