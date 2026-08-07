import { mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactCoordinator } from '../artifacts/coordinator.js';
import { createTurnFileArtifactTracker, resolveScanRoots } from '../artifacts/file-artifacts.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { loadConfig } from '../config/index.js';
import { getDeliverableVersionsDir } from '../paths.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createSession } from '../memory/sessions.js';
import { getDb } from './db.js';
import { getOutputDir, isPathInsideRoot } from '../tools/workspace-policy.js';
import { deliverableVersionStore } from './deliverable-versions.js';
import { deliverableRegistry } from './deliverables.js';

describe('store/deliverables', () => {
  const savedMoziHome = process.env.MOZI_HOME;
  let tmpDir: string;

  beforeEach(() => {
    ({ tmpDir } = setupTestDb());
    process.env.MOZI_HOME = tmpDir;
    loadConfig('/nonexistent/mozi.json');
  });

  afterEach(() => {
    if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
    else process.env.MOZI_HOME = savedMoziHome;
    loadConfig('/nonexistent/mozi.json');
    teardownTestDb(tmpDir);
  });

  it('continues minting when the snapshot directory cannot be created', async () => {
    const outputDir = getOutputDir();
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(tmpDir, 'versions'), 'blocks directory creation');
    const filePath = join(outputDir, 'snapshot-failure.pdf');
    writeFileSync(filePath, '%PDF-1.4\nstill mint this');
    const future = new Date(Date.now() + 2_000);
    utimesSync(filePath, future, future);
    const events: ArtifactEvent[] = [];
    const tracker = createTurnFileArtifactTracker({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      artifactCoordinator: new ArtifactCoordinator('turn-a', (event) => events.push(event)),
    });

    await tracker.scanAndEmit();

    const registered = deliverableRegistry.getByPath('tenant-a', realpathSync(filePath));
    expect(registered).not.toBeNull();
    expect(registered?.versionCount).toBe(0);
    expect(deliverableVersionStore.listByDeliverable('tenant-a', registered!.id)).toEqual([]);
    expect(events.some((event) => event.type === 'open' && event.artifact.title === 'snapshot-failure.pdf')).toBe(true);
  });

  it('keeps the server-owned versions directory outside every scan root', () => {
    const versionsDir = getDeliverableVersionsDir('dlv_test');
    expect(resolveScanRoots().every((root) => !isPathInsideRoot(versionsDir, root.path))).toBe(true);
  });

  it('isolates every CRUD lookup by tenant', () => {
    const sharedPath = join(tmpDir, 'shared-deliverable.pdf');
    writeFileSync(sharedPath, 'shared bytes');
    const alpha = deliverableRegistry.upsertByPath({
      tenantId: 'tenant-alpha',
      path: sharedPath,
      kind: 'document',
      title: 'shared-deliverable.pdf',
      currentSize: 10,
      currentMtimeMs: 100,
      currentHash: 'alpha-hash',
      sessionId: 'alpha-session',
    });
    const beta = deliverableRegistry.upsertByPath({
      tenantId: 'tenant-beta',
      path: sharedPath,
      kind: 'document',
      title: 'shared-deliverable.pdf',
      currentSize: 20,
      currentMtimeMs: 200,
      currentHash: 'beta-hash',
      sessionId: 'beta-session',
    });

    expect(alpha.id).not.toBe(beta.id);
    expect(deliverableRegistry.getById('tenant-alpha', beta.id)).toBeNull();
    expect(deliverableRegistry.getById('tenant-beta', alpha.id)).toBeNull();
    expect(deliverableRegistry.getByPath('tenant-alpha', sharedPath)?.id).toBe(alpha.id);
    expect(deliverableRegistry.getByPath('tenant-beta', sharedPath)?.id).toBe(beta.id);
    expect(deliverableRegistry.listByTenant('tenant-alpha').map((row) => row.id)).toEqual([alpha.id]);
    expect(deliverableRegistry.listByTenant('tenant-beta').map((row) => row.id)).toEqual([beta.id]);

    deliverableVersionStore.snapshot({
      tenantId: 'tenant-alpha',
      deliverableId: alpha.id,
      version: 1,
      sourcePath: sharedPath,
      hash: 'alpha-hash',
    });
    expect(deliverableVersionStore.getByVersion('tenant-beta', alpha.id, 1)).toBeNull();
    expect(deliverableVersionStore.listByDeliverable('tenant-beta', alpha.id)).toEqual([]);
  });

  it('matches title or path with tenant-scoped LIKE ordering and no empty fallback', () => {
    const olderSession = createSession('search-user', 'Older work', 'search-tenant');
    const newerSession = createSession('search-user', 'Latest weekly review', 'search-tenant');
    const older = deliverableRegistry.upsertByPath({
      tenantId: 'search-tenant',
      path: '/workspace/finance-archive.pdf',
      kind: 'document',
      title: '财务归档',
      currentSize: 10,
      currentMtimeMs: 1,
      currentHash: null,
      sessionId: olderSession.id,
    });
    const newer = deliverableRegistry.upsertByPath({
      tenantId: 'search-tenant',
      path: '/workspace/weekly-report.pptx',
      kind: 'deck',
      title: '上周周报',
      currentSize: 20,
      currentMtimeMs: 2,
      currentHash: null,
      sessionId: newerSession.id,
      initialVersionCount: 4,
    });
    getDb().prepare('UPDATE deliverables SET updated_at = ? WHERE id = ?')
      .run('2026-07-20T10:00:00.000Z', older.id);
    getDb().prepare('UPDATE deliverables SET updated_at = ? WHERE id = ?')
      .run('2026-07-21T10:00:00.000Z', newer.id);

    expect(deliverableRegistry.search('search-tenant', '周报')).toEqual([
      expect.objectContaining({
        deliverableId: newer.id,
        title: '上周周报',
        version: 4,
        sessionTitle: 'Latest weekly review',
      }),
    ]);
    expect(deliverableRegistry.search('search-tenant', 'workspace')).toEqual([
      expect.objectContaining({ deliverableId: newer.id }),
      expect.objectContaining({ deliverableId: older.id }),
    ]);
    expect(deliverableRegistry.search('search-tenant', '   ')).toEqual([]);
    expect(deliverableRegistry.search('other-tenant', '周报')).toEqual([]);
    expect(deliverableRegistry.search('search-tenant', 'does-not-exist')).toEqual([]);
  });
});
