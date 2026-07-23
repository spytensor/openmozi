import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/index.js';
import { getDb } from '../store/db.js';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import {
  buildArtifactPersistedRelativePath,
  getLatestArtifactVersion,
  getNextArtifactVersionNumber,
  insertArtifactVersion,
  persistArtifactContent,
  persistArtifactContentToPath,
} from './versioning.js';

let tmpDir: string;
let dbTmpDir: string;
let savedMoziHome: string | undefined;
const testUserId = 'user-artifact-versioning';

beforeAll(() => {
  tmpDir = createTempDir();
  savedMoziHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = join(tmpDir, 'mozi-home');
  process.env.MOZI_WORKSPACES = join(tmpDir, 'user-workspaces');
  loadConfig('/nonexistent/mozi.json');
});

beforeEach(() => {
  const dbSetup = setupTestDb();
  dbTmpDir = dbSetup.tmpDir;
  loadConfig('/nonexistent/mozi.json');
});

afterEach(() => {
  teardownTestDb(dbTmpDir);
});

afterAll(() => {
  delete process.env.MOZI_WORKSPACES;
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
  removeTempDir(tmpDir);
  loadConfig('/nonexistent/mozi.json');
});

describe('artifacts/versioning', () => {
  it('keeps unrelated CJK report titles on distinct persisted paths', () => {
    const southAsia = buildArtifactPersistedRelativePath({
      title: '南亚国家税务研究 2026年Q2',
      contentType: 'markdown',
      sessionId: 'same-session',
    });
    const gulf = buildArtifactPersistedRelativePath({
      title: '海湾国家税务研究 2026年Q2',
      contentType: 'markdown',
      sessionId: 'same-session',
    });
    expect(southAsia).not.toBe(gulf);
  });

  it('returns the latest artifact version while preserving queryable history', async () => {
    const artifactId = 'artifact_history_root';
    const v1 = '# History Draft\n\nParagraph one.\n\nParagraph two before edit.';
    const v2 = '# History Draft\n\nParagraph one.\n\nParagraph two after edit.';

    const persistedPath = await persistArtifactContent({
      title: 'History Draft',
      contentType: 'markdown',
      content: v1,
      sessionId: 'session-versioning',
      userId: testUserId,
    });
    expect(persistedPath).toContain(join('user-workspaces', testUserId, 'artifacts', 'session-versioning'));
    expect(persistedPath).toMatch(/history-draft-[a-f0-9]{10}\.md$/);
    expect(readFileSync(persistedPath, 'utf-8')).toBe(v1);

    insertArtifactVersion({
      id: 'artifact_history_v1',
      artifactId,
      tenantId: 'default',
      versionNumber: 1,
      content: v1,
      persistedPath,
      createdAt: 100,
    });

    expect(getNextArtifactVersionNumber(artifactId, 'default')).toBe(2);

    const updatedPath = await persistArtifactContentToPath(persistedPath, v2, testUserId);
    expect(updatedPath).toBe(persistedPath);
    expect(readFileSync(persistedPath, 'utf-8')).toBe(v2);

    insertArtifactVersion({
      id: 'artifact_history_v2',
      artifactId,
      tenantId: 'default',
      versionNumber: getNextArtifactVersionNumber(artifactId, 'default'),
      content: v2,
      persistedPath,
      changeDescription: 'Edit paragraph two',
      createdAt: 200,
    });

    const latest = getLatestArtifactVersion(artifactId, 'default');
    expect(latest).toMatchObject({
      id: 'artifact_history_v2',
      artifact_id: artifactId,
      version_number: 2,
      content: v2,
      persisted_path: persistedPath,
      change_description: 'Edit paragraph two',
    });

    expect(getLatestArtifactVersion('artifact_history_v1', 'default')).toMatchObject({
      id: 'artifact_history_v2',
      artifact_id: artifactId,
      version_number: 2,
      content: v2,
    });

    const rows = getDb().prepare(`
      SELECT id, artifact_id, version_number, content, persisted_path, change_description
      FROM artifact_versions
      WHERE artifact_id = ?
      ORDER BY version_number ASC
    `).all(artifactId) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.version_number)).toEqual([1, 2]);
    expect(rows.map(row => row.content)).toEqual([v1, v2]);
    expect(rows[0]).toMatchObject({
      id: 'artifact_history_v1',
      artifact_id: artifactId,
      persisted_path: persistedPath,
      change_description: null,
    });
    expect(rows[1]).toMatchObject({
      id: 'artifact_history_v2',
      artifact_id: artifactId,
      persisted_path: persistedPath,
      change_description: 'Edit paragraph two',
    });
  });

  describe('tenant isolation', () => {
    // `update_artifact` takes artifact_id straight from the model. Before this,
    // artifact_versions had no tenant_id and the lookup filtered on artifact_id
    // alone, so the only thing between tenants was the filesystem write gate —
    // which is a no-op when tools.fs.workspace_only is disabled.
    const seed = (artifactId: string, tenantId: string, content: string) => {
      insertArtifactVersion({
        id: `ver_${tenantId}_${artifactId}`,
        artifactId,
        tenantId,
        versionNumber: 1,
        content,
        persistedPath: `/tmp/${tenantId}/${artifactId}.md`,
        createdAt: 100,
      });
    };

    it('does not resolve another tenant\'s artifact by id', () => {
      seed('artifact_shared_id', 'tenant-b', 'bob secret content');

      expect(getLatestArtifactVersion('artifact_shared_id', 'tenant-a')).toBeNull();
      expect(getLatestArtifactVersion('artifact_shared_id', 'tenant-b')).toMatchObject({
        content: 'bob secret content',
      });
    });

    it('does not resolve another tenant\'s artifact by version id', () => {
      seed('artifact_by_version', 'tenant-b', 'bob secret content');

      // The id->artifact_id hop must be scoped too, or it launders the lookup.
      expect(getLatestArtifactVersion('ver_tenant-b_artifact_by_version', 'tenant-a')).toBeNull();
    });

    it('keeps version numbering per tenant', () => {
      seed('artifact_same_id', 'tenant-a', 'alice v1');
      seed('artifact_same_id', 'tenant-b', 'bob v1');

      // Each tenant continues its own history rather than inheriting the other's.
      expect(getNextArtifactVersionNumber('artifact_same_id', 'tenant-a')).toBe(2);
      expect(getNextArtifactVersionNumber('artifact_same_id', 'tenant-b')).toBe(2);
      expect(getLatestArtifactVersion('artifact_same_id', 'tenant-a')).toMatchObject({ content: 'alice v1' });
      expect(getLatestArtifactVersion('artifact_same_id', 'tenant-b')).toMatchObject({ content: 'bob v1' });
    });
  });
});
