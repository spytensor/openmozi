import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { registerApiRoutes } from './api-routes.js';
import { getConfigPath } from './paths.js';
import { loadConfig } from './config/index.js';
import { setupTestDb, teardownTestDb } from './test-helpers.js';
import { resolveWritePath } from './tools/tool-utils.js';
import { getWorkspaceDir } from './tools/workspace-policy.js';
import { exec } from './capabilities/shell.js';
import { createSession, getSession } from './memory/sessions.js';
import { compileIntelligentContext } from './memory/context-builder.js';
import { saveTimelineItem } from './memory/session-timeline.js';
import { deliverableRegistry } from './store/deliverables.js';
import { deliverableVersionStore } from './store/deliverable-versions.js';
import { sessionDeliverableBindingStore } from './store/session-deliverable-bindings.js';
import { sign as jwtSign } from './security/jwt.js';

describe('api fs roots', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  const savedOfficeEnv = {
    browser: process.env.OFFICE_DOCUMENT_SERVER_URL,
    internal: process.env.OFFICE_DOCUMENT_SERVER_INTERNAL_URL,
    storage: process.env.OFFICE_STORAGE_BASE_URL,
    secret: process.env.ONLYOFFICE_JWT_SECRET,
  };
  let moziHome: string;
  let projectDir: string;
  let outsideDir: string;
  let dbTmpDir: string;

  beforeEach(() => {
    moziHome = mkdtempSync(join(tmpdir(), 'mozi-fs-roots-home-'));
    projectDir = mkdtempSync(join(tmpdir(), 'mozi-fs-project-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'mozi-fs-outside-'));
    process.env.MOZI_HOME = moziHome;
    loadConfig(getConfigPath());
    dbTmpDir = setupTestDb().tmpDir;
  });

  afterEach(() => {
    teardownTestDb(dbTmpDir);
    rmSync(moziHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    if (savedMoziHome === undefined) {
      delete process.env.MOZI_HOME;
    } else {
      process.env.MOZI_HOME = savedMoziHome;
    }
    loadConfig('/nonexistent/mozi.json');
    for (const [key, value] of Object.entries({
      OFFICE_DOCUMENT_SERVER_URL: savedOfficeEnv.browser,
      OFFICE_DOCUMENT_SERVER_INTERNAL_URL: savedOfficeEnv.internal,
      OFFICE_STORAGE_BASE_URL: savedOfficeEnv.storage,
      ONLYOFFICE_JWT_SECRET: savedOfficeEnv.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('requires authentication when auth mode is token', async () => {
    const app = Fastify();
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'token', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({ method: 'GET', url: '/api/fs/roots' });
      expect(response.statusCode).toBe(401);

      const fileResponse = await app.inject({ method: 'GET', url: '/api/fs/file?path=/tmp/nope.txt' });
      expect(fileResponse.statusCode).toBe(401);

      const previewResponse = await app.inject({ method: 'GET', url: '/api/fs/preview?path=/tmp/nope.pdf&w=512' });
      expect(previewResponse.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('joins registry identity onto deliverables and leaves legacy files null', async () => {
    const app = Fastify();
    const tenantId = 'default';
    const userId = 'local-user';
    const session = createSession(userId, 'Registry API', tenantId);
    const workspace = getWorkspaceDir(userId);
    mkdirSync(workspace, { recursive: true });
    const registeredPath = join(workspace, 'registered.pdf');
    const legacyPath = join(workspace, 'legacy.pdf');
    writeFileSync(registeredPath, '%PDF-1.4\nregistered');
    writeFileSync(legacyPath, '%PDF-1.4\nlegacy');

    for (const [artifactId, path, timestamp] of [
      ['artifact-registered', registeredPath, 2],
      ['artifact-legacy', legacyPath, 1],
    ] as const) {
      saveTimelineItem({
        tenantId,
        sessionId: session.id,
        chatId: userId,
        type: 'artifact',
        eventKey: `artifact:${artifactId}`,
        timestamp,
        data: {
          id: artifactId,
          plugin_id: 'file_v1',
          title: artifactId,
          status: 'completed',
          data: { path, filename: path.split('/').at(-1), kind: 'document' },
        },
      });
    }
    const registered = deliverableRegistry.upsertByPath({
      tenantId,
      path: realpathSync(registeredPath),
      kind: 'document',
      title: 'registered.pdf',
      currentSize: statSync(registeredPath).size,
      currentMtimeMs: statSync(registeredPath).mtimeMs,
      currentHash: 'registered-hash',
      sessionId: session.id,
    });

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({ method: 'GET', url: '/api/fs/deliverables' });
      expect(response.statusCode).toBe(200);
      const entries = response.json().groups.flatMap((group: { deliverables: unknown[] }) => group.deliverables) as Array<{
        filename: string;
        deliverableId: string | null;
        versionCount: number | null;
      }>;
      expect(entries.find((entry) => entry.filename === 'registered.pdf')).toMatchObject({
        deliverableId: registered.id,
        versionCount: 1,
      });
      expect(entries.find((entry) => entry.filename === 'legacy.pdf')).toMatchObject({
        deliverableId: null,
        versionCount: null,
      });
    } finally {
      await app.close();
    }
  });

  it('creates a bound continuation session through the API and injects its exact path and version', async () => {
    const app = Fastify();
    const tenantId = 'default';
    const userId = 'local-user';
    const workspace = getWorkspaceDir(userId);
    mkdirSync(workspace, { recursive: true });
    const filePath = join(workspace, 'continuation-report.pdf');
    writeFileSync(filePath, '%PDF-1.4\ncontinuation');
    const canonicalPath = realpathSync(filePath);
    const deliverable = deliverableRegistry.upsertByPath({
      tenantId,
      path: canonicalPath,
      kind: 'document',
      title: 'Continuation report',
      currentSize: statSync(canonicalPath).size,
      currentMtimeMs: Math.trunc(statSync(canonicalPath).mtimeMs),
      currentHash: 'continuation-hash',
      sessionId: 'source-session',
      initialVersionCount: 5,
    });

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/api/deliverables/${deliverable.id}/continue`,
      });
      expect(response.statusCode).toBe(200);
      const sessionId = response.json().session_id as string;
      expect(sessionId).toMatch(/^sess-/);
      expect(getSession(sessionId, tenantId)).toMatchObject({
        user_id: userId,
        title: 'Continuation report',
      });
      expect(sessionDeliverableBindingStore.listBySession(tenantId, sessionId)).toEqual([
        expect.objectContaining({ deliverableId: deliverable.id }),
      ]);

      const compiled = await compileIntelligentContext(
        userId,
        'sys',
        'Continue editing this report.',
        tenantId,
        userId,
        sessionId,
      );
      const context = compiled.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n');
      expect(context).toContain(`"deliverableId":"${deliverable.id}"`);
      expect(context).toContain(`"path":"${canonicalPath}"`);
      expect(context).toContain('"version":5');
      expect(context).toContain('"title":"Continuation report"');

      const isolated = await app.inject({
        method: 'POST',
        url: `/api/deliverables/${deliverable.id}/continue`,
        headers: {
          authorization: `Bearer ${jwtSign('other-user', 'test-secret', 3600, { tenant_id: 'other-tenant', roles: ['admin'] })}`,
        },
      });
      expect(isolated.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rolls back an allowed deliverable as a new version and isolates tenants', async () => {
    const app = Fastify();
    const tenantId = 'default';
    const outputDir = join(moziHome, 'output');
    const filePath = join(outputDir, 'rollback-report.pdf');
    mkdirSync(outputDir, { recursive: true });
    const firstBytes = '%PDF-1.4\nfirst version';
    const secondBytes = '%PDF-1.4\nsecond version is longer';
    writeFileSync(filePath, firstBytes);
    const firstMtime = new Date(Date.now() + 2_000);
    utimesSync(filePath, firstMtime, firstMtime);
    const canonicalPath = realpathSync(filePath);
    const deliverable = deliverableRegistry.upsertByPath({
      tenantId,
      path: canonicalPath,
      kind: 'document',
      title: 'rollback-report.pdf',
      currentSize: Buffer.byteLength(firstBytes),
      currentMtimeMs: firstMtime.getTime(),
      currentHash: 'first-hash',
    });
    deliverableVersionStore.snapshot({
      tenantId,
      deliverableId: deliverable.id,
      version: 1,
      sourcePath: canonicalPath,
      hash: 'first-hash',
    });
    writeFileSync(filePath, secondBytes);
    const secondMtime = new Date(Date.now() + 4_000);
    utimesSync(filePath, secondMtime, secondMtime);
    deliverableRegistry.upsertByPath({
      tenantId,
      path: canonicalPath,
      kind: 'document',
      title: 'rollback-report.pdf',
      currentSize: Buffer.byteLength(secondBytes),
      currentMtimeMs: secondMtime.getTime(),
      currentHash: 'second-hash',
    });
    deliverableVersionStore.snapshot({
      tenantId,
      deliverableId: deliverable.id,
      version: 2,
      sourcePath: canonicalPath,
      hash: 'second-hash',
    });

    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const listed = await app.inject({ method: 'GET', url: `/api/deliverables/${deliverable.id}/versions` });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().versions.map((entry: { version: number }) => entry.version)).toEqual([2, 1]);

      const otherTenantHeaders = {
        authorization: `Bearer ${jwtSign('other-user', 'test-secret', 3600, { tenant_id: 'other-tenant', roles: ['admin'] })}`,
      };
      const isolatedRead = await app.inject({
        method: 'GET',
        url: `/api/deliverables/${deliverable.id}/versions`,
        headers: otherTenantHeaders,
      });
      expect(isolatedRead.statusCode).toBe(404);
      const isolatedRollback = await app.inject({
        method: 'POST',
        url: `/api/deliverables/${deliverable.id}/rollback`,
        headers: otherTenantHeaders,
        payload: { version: 1 },
      });
      expect(isolatedRollback.statusCode).toBe(404);

      const rolledBack = await app.inject({
        method: 'POST',
        url: `/api/deliverables/${deliverable.id}/rollback`,
        payload: { version: 1 },
      });
      expect(rolledBack.statusCode).toBe(200);
      expect(readFileSync(filePath, 'utf8')).toBe(firstBytes);
      expect(rolledBack.json().version).toMatchObject({ version: 3 });
      expect(deliverableVersionStore.listByDeliverable(tenantId, deliverable.id).map((entry) => entry.version)).toEqual([3, 2, 1]);
      expect(deliverableVersionStore.getByVersion(tenantId, deliverable.id, 3)?.hash).toBe('first-hash');
      expect(deliverableRegistry.getById(tenantId, deliverable.id)?.versionCount).toBe(3);
    } finally {
      await app.close();
    }
  });

  it('streams allowed files with UTF-8 attachment disposition and 404s outside roots', async () => {
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const filename = '报告.pdf';
    const filePath = join(outputDir, filename);
    const outsidePath = join(outsideDir, 'outside.pdf');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(filePath, '%PDF-1.4\nallowed');
      writeFileSync(outsidePath, '%PDF-1.4\noutside');

      const served = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(filePath)}`,
      });
      expect(served.statusCode).toBe(200);
      const contentType = String(served.headers['content-type'] ?? '');
      const contentDisposition = String(served.headers['content-disposition'] ?? '');
      expect(contentType).toContain('application/pdf');
      expect(contentDisposition).toContain('attachment');
      expect(contentDisposition).toContain(`filename*=UTF-8''${encodeURIComponent(filename)}`);
      expect(served.body).toBe('%PDF-1.4\nallowed');

      const outside = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(outsidePath)}`,
      });
      expect(outside.statusCode).toBe(404);

      const outsidePreview = await app.inject({
        method: 'GET',
        url: `/api/fs/preview?path=${encodeURIComponent(outsidePath)}&w=512`,
      });
      expect(outsidePreview.statusCode).toBe(404);
      expect(outsidePreview.json()).toMatchObject({ success: false, code: 'file_not_found' });

      const missing = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(join(outputDir, 'missing.pdf'))}`,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('serves Docker-era artifact paths only through their current allowed App roots', async () => {
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const userId = 'local-user';
    const userWorkspace = join(moziHome, 'workspace');
    const outputFile = join(outputDir, 'archive', 'report.pdf');
    const workspaceFile = join(userWorkspace, 'sheet.xlsx');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      mkdirSync(dirname(outputFile), { recursive: true });
      mkdirSync(userWorkspace, { recursive: true });
      writeFileSync(outputFile, '%PDF-1.4\nlegacy output');
      writeFileSync(workspaceFile, 'legacy workspace');

      const outputResponse = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent('/data/output/archive/report.pdf')}`,
      });
      expect(outputResponse.statusCode).toBe(200);
      expect(outputResponse.body).toBe('%PDF-1.4\nlegacy output');

      const workspaceResponse = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent(`/data/workspace/users/${userId}/sheet.xlsx`)}`,
      });
      expect(workspaceResponse.statusCode).toBe(200);
      expect(workspaceResponse.body).toBe('legacy workspace');

      const traversal = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent('/data/output/../../outside.pdf')}`,
      });
      expect(traversal.statusCode).toBe(404);

      const otherUser = await app.inject({
        method: 'GET',
        url: `/api/fs/file?path=${encodeURIComponent('/data/workspace/users/user-b/sheet.xlsx')}`,
      });
      expect(otherUser.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('creates a signed native Office session and serves its file token without a browser cookie', async () => {
    process.env.OFFICE_DOCUMENT_SERVER_URL = 'http://localhost:8082';
    process.env.OFFICE_DOCUMENT_SERVER_INTERNAL_URL = 'http://onlyoffice';
    process.env.OFFICE_STORAGE_BASE_URL = 'http://mozi:9210';
    process.env.ONLYOFFICE_JWT_SECRET = 'test-onlyoffice-secret';
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const filePath = join(outputDir, 'budget.xlsx');
    const outsidePath = join(outsideDir, 'outside.xlsx');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });
      mkdirSync(outputDir, { recursive: true });
      writeFileSync(filePath, 'xlsx bytes');
      writeFileSync(outsidePath, 'outside bytes');

      const session = await app.inject({
        method: 'GET',
        url: `/api/office/session?path=${encodeURIComponent(filePath)}&locale=zh-CN`,
      });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({
        available: true,
        engine: 'onlyoffice',
        editable: false,
        config: { documentType: 'cell', editorConfig: { mode: 'view', lang: 'zh-CN' } },
      });
      const documentUrl = new URL(session.json().config.document.url);
      const served = await app.inject({ method: 'GET', url: `${documentUrl.pathname}${documentUrl.search}` });
      expect(served.statusCode).toBe(200);
      expect(served.body).toBe('xlsx bytes');

      const outside = await app.inject({
        method: 'GET',
        url: `/api/office/session?path=${encodeURIComponent(outsidePath)}`,
      });
      expect(outside.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('grants, persists, live-allows, and revokes project roots for fs and shell policy', async () => {
    const app = Fastify();
    const outputDir = join(moziHome, 'output');
    const workspaceDir = join(moziHome, 'workspace');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      const initial = await app.inject({ method: 'GET', url: '/api/fs/roots' });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toMatchObject({
        success: true,
        roots: expect.arrayContaining([
          expect.objectContaining({ tier: 'output', path: outputDir }),
          expect.objectContaining({ tier: 'workspace', path: workspaceDir }),
        ]),
      });
      expect(existsSync(outputDir)).toBe(true);
      expect(existsSync(workspaceDir)).toBe(true);

      const granted = await app.inject({
        method: 'POST',
        url: '/api/fs/roots',
        payload: { path: projectDir },
      });
      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toMatchObject({
        success: true,
        root: expect.objectContaining({
          tier: 'project',
          path: projectDir,
          label: expect.any(String),
          bookmark: null,
        }),
      });

      const rawConfig = JSON.parse(readFileSync(getConfigPath(), 'utf-8')) as {
        tools?: { fs?: { additional_allowed_roots?: string[]; granted_project_roots?: Array<{ path: string; bookmark: string | null }> } };
      };
      expect(rawConfig.tools?.fs?.additional_allowed_roots).toContain(projectDir);
      expect(rawConfig.tools?.fs?.granted_project_roots?.[0]).toMatchObject({
        path: projectDir,
        bookmark: null,
      });

      loadConfig(getConfigPath());
      const projectFile = join(projectDir, 'accepted.txt');
      expect(resolveWritePath(projectFile)).toBe(projectFile);

      const shellAllowed = await exec('pwd', {
        cwd: projectDir,
        enforceWorkspaceBoundary: true,
        permissionLevel: 'L2_SHELL_EXEC',
      });
      expect(shellAllowed.blocked).toBe(false);
      expect(realpathSync(shellAllowed.stdout.trim())).toBe(realpathSync(projectDir));

      const outsideFile = join(outsideDir, 'blocked.txt');
      let refusal = '';
      try {
        resolveWritePath(outsideFile);
      } catch (err) {
        refusal = err instanceof Error ? err.message : String(err);
      }
      expect(refusal).toContain('workspace_only policy');
      expect(refusal).toContain(outputDir);
      expect(refusal).toContain(workspaceDir);
      expect(refusal).toContain(projectDir);

      const revoked = await app.inject({
        method: 'DELETE',
        url: '/api/fs/roots',
        payload: { path: projectDir },
      });
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json()).toMatchObject({ success: true, revoked: true });
      expect(revoked.json().roots).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ path: projectDir })]),
      );

      expect(() => resolveWritePath(join(projectDir, 'after-revoke.txt'))).toThrow('workspace_only policy');
      const shellRevoked = await exec('pwd', {
        cwd: projectDir,
        enforceWorkspaceBoundary: true,
        permissionLevel: 'L2_SHELL_EXEC',
      });
      expect(shellRevoked.blocked).toBe(true);
      expect(shellRevoked.stderr).toContain(outputDir);
      expect(shellRevoked.stderr).toContain(workspaceDir);
    } finally {
      await app.close();
    }
  });

  it('lists display names and creates and moves entries inside allowed roots', async () => {
    const app = Fastify();
    const workspaceDir = join(moziHome, 'workspace');
    try {
      await registerApiRoutes(app, {
        jwtSecret: 'test-secret',
        config: {
          server: { auth_mode: 'none', host: '127.0.0.1' },
          security: { enterprise: {} },
          http_rate_limit: { global_rpm: 100, auth_rpm: 10, pair_rpm: 5 },
        },
      });

      mkdirSync(workspaceDir, { recursive: true });
      const storedName = '1712345678901-abcdef-report.pdf';
      const sourcePath = join(workspaceDir, storedName);
      writeFileSync(sourcePath, '%PDF-1.4\nreport');
      const realSourcePath = realpathSync(sourcePath);

      const listed = await app.inject({
        method: 'GET',
        url: `/api/fs/list?dir=${encodeURIComponent(workspaceDir)}`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: storedName,
            displayName: 'report.pdf',
            path: realSourcePath,
          }),
        ]),
      );

      const created = await app.inject({
        method: 'POST',
        url: '/api/fs/mkdir',
        payload: { dir: workspaceDir, name: 'Project Alpha' },
      });
      expect(created.statusCode).toBe(200);
      const projectPath = realpathSync(join(workspaceDir, 'Project Alpha'));
      expect(created.json()).toMatchObject({ success: true, path: projectPath });
      expect(existsSync(projectPath)).toBe(true);

      const badName = await app.inject({
        method: 'POST',
        url: '/api/fs/mkdir',
        payload: { dir: workspaceDir, name: '../escape' },
      });
      expect(badName.statusCode).toBe(400);

      const conflict = await app.inject({
        method: 'POST',
        url: '/api/fs/mkdir',
        payload: { dir: workspaceDir, name: 'Project Alpha' },
      });
      expect(conflict.statusCode).toBe(409);

      const moved = await app.inject({
        method: 'POST',
        url: '/api/fs/move',
        payload: { paths: [sourcePath], destDir: projectPath },
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json()).toMatchObject({
        success: true,
        moved: [{ from: realSourcePath, to: join(projectPath, storedName) }],
        errors: [],
      });
      expect(existsSync(sourcePath)).toBe(false);
      expect(readFileSync(join(projectPath, storedName), 'utf8')).toContain('report');

      const outsideSource = join(outsideDir, 'outside.txt');
      writeFileSync(outsideSource, 'outside');
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/fs/move',
        payload: { paths: [outsideSource], destDir: projectPath },
      });
      expect(rejected.statusCode).toBe(200);
      expect(rejected.json()).toMatchObject({
        success: false,
        moved: [],
        errors: [expect.objectContaining({ path: outsideSource, status: 404 })],
      });

      const generatedOutput = join(moziHome, 'output');
      mkdirSync(generatedOutput, { recursive: true });
      const generatedArchive = join(generatedOutput, 'archive');
      const generatedFile = join(generatedOutput, 'generated.pdf');
      mkdirSync(generatedArchive, { recursive: true });
      writeFileSync(generatedFile, '%PDF-1.4\ngenerated');
      const realGeneratedFile = realpathSync(generatedFile);
      const realGeneratedArchive = realpathSync(generatedArchive);
      const outputReorganized = await app.inject({
        method: 'POST',
        url: '/api/fs/move',
        payload: { paths: [generatedFile], destDir: generatedArchive },
      });
      expect(outputReorganized.statusCode).toBe(200);
      expect(outputReorganized.json()).toMatchObject({
        success: true,
        moved: [{ from: realGeneratedFile, to: join(realGeneratedArchive, 'generated.pdf') }],
        errors: [],
      });
      expect(existsSync(join(generatedArchive, 'generated.pdf'))).toBe(true);

      const externalInput = join(workspaceDir, 'external-input.pdf');
      writeFileSync(externalInput, '%PDF-1.4\nexternal');
      const outputRejected = await app.inject({
        method: 'POST',
        url: '/api/fs/move',
        payload: { paths: [externalInput], destDir: generatedOutput },
      });
      expect(outputRejected.statusCode).toBe(200);
      expect(outputRejected.json()).toMatchObject({
        success: false,
        moved: [],
        errors: [expect.objectContaining({ path: externalInput, status: 400 })],
      });
      expect(existsSync(externalInput)).toBe(true);
      expect(existsSync(join(generatedOutput, 'external-input.pdf'))).toBe(false);
    } finally {
      await app.close();
    }
  });
});
