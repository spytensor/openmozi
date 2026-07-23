import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../memory/sessions.js';
import { deliverableRegistry } from '../store/deliverables.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { executeTool } from './executor.js';

describe('tools/find_deliverable', () => {
  let tmpDir: string;

  beforeEach(() => {
    ({ tmpDir } = setupTestDb());
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('returns only matching registry rows for the current tenant', async () => {
    const session = createSession('lookup-user', 'Weekly reporting', 'lookup-tenant');
    const deliverable = deliverableRegistry.upsertByPath({
      tenantId: 'lookup-tenant',
      path: '/workspace/weekly-report.pptx',
      kind: 'deck',
      title: '上周周报',
      currentSize: 42,
      currentMtimeMs: 100,
      currentHash: 'hash',
      sessionId: session.id,
      initialVersionCount: 2,
    });
    deliverableRegistry.upsertByPath({
      tenantId: 'other-tenant',
      path: '/workspace/weekly-report-other.pptx',
      kind: 'deck',
      title: '上周周报',
      currentSize: 43,
      currentMtimeMs: 101,
      currentHash: 'other-hash',
    });

    const result = await executeTool({
      id: 'call-find',
      function: { name: 'find_deliverable', arguments: JSON.stringify({ query: '周报' }) },
    }, {
      tenantId: 'lookup-tenant',
      agentId: 'brain',
      permissionLevel: 'L0_READ_ONLY',
    });
    expect(result.is_error).toBe(false);
    expect(JSON.parse(result.content)).toEqual([{
      deliverableId: deliverable.id,
      title: '上周周报',
      path: '/workspace/weekly-report.pptx',
      kind: 'deck',
      version: 2,
      updatedAt: deliverable.updatedAt,
      sessionTitle: 'Weekly reporting',
    }]);

    const empty = await executeTool({
      id: 'call-empty',
      function: { name: 'find_deliverable', arguments: JSON.stringify({ query: 'missing' }) },
    }, {
      tenantId: 'lookup-tenant',
      agentId: 'brain',
      permissionLevel: 'L0_READ_ONLY',
    });
    expect(JSON.parse(empty.content)).toEqual([]);
  });

  it('imports no filesystem APIs in the tool implementation', () => {
    const source = readFileSync(fileURLToPath(new URL('./deliverable-tools.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/from ['"]node:fs(?:\/[^'"]*)?['"]/);
    expect(source).not.toMatch(/from ['"]fs(?:\/[^'"]*)?['"]/);
  });
});
