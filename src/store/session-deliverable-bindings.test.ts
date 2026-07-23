import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../memory/sessions.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { deliverableRegistry } from './deliverables.js';
import { sessionDeliverableBindingStore } from './session-deliverable-bindings.js';

describe('store/session-deliverable-bindings', () => {
  let tmpDir: string;

  beforeEach(() => {
    ({ tmpDir } = setupTestDb());
  });

  afterEach(() => {
    teardownTestDb(tmpDir);
  });

  it('creates, reads, updates, lists, and deletes a tenant-scoped binding', () => {
    const binding = sessionDeliverableBindingStore.create({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      deliverableId: 'deliverable-a',
      createdAt: '2026-07-21T10:00:00.000Z',
    });
    expect(binding).toEqual({
      tenantId: 'tenant-a',
      sessionId: 'session-a',
      deliverableId: 'deliverable-a',
      createdAt: '2026-07-21T10:00:00.000Z',
    });
    expect(sessionDeliverableBindingStore.get('tenant-a', 'session-a', 'deliverable-a')).toEqual(binding);

    const updated = sessionDeliverableBindingStore.updateCreatedAt(
      'tenant-a',
      'session-a',
      'deliverable-a',
      '2026-07-21T11:00:00.000Z',
    );
    expect(updated?.createdAt).toBe('2026-07-21T11:00:00.000Z');
    expect(sessionDeliverableBindingStore.listBySession('tenant-a', 'session-a')).toEqual([updated]);
    expect(sessionDeliverableBindingStore.remove('tenant-a', 'session-a', 'deliverable-a')).toBe(true);
    expect(sessionDeliverableBindingStore.get('tenant-a', 'session-a', 'deliverable-a')).toBeNull();
  });

  it('isolates CRUD and joined deliverable reads by tenant and session owner', () => {
    const alphaSession = createSession('user-alpha', 'Alpha', 'tenant-alpha');
    const betaSession = createSession('user-beta', 'Beta', 'tenant-beta');
    const alphaDeliverable = deliverableRegistry.upsertByPath({
      tenantId: 'tenant-alpha',
      path: '/tmp/alpha.pdf',
      kind: 'document',
      title: 'Alpha report',
      currentSize: 10,
      currentMtimeMs: 1,
      currentHash: null,
      sessionId: alphaSession.id,
      initialVersionCount: 3,
    });
    const betaDeliverable = deliverableRegistry.upsertByPath({
      tenantId: 'tenant-beta',
      path: '/tmp/beta.pdf',
      kind: 'document',
      title: 'Beta report',
      currentSize: 20,
      currentMtimeMs: 2,
      currentHash: null,
      sessionId: betaSession.id,
    });
    sessionDeliverableBindingStore.create({
      tenantId: 'tenant-alpha',
      sessionId: alphaSession.id,
      deliverableId: alphaDeliverable.id,
    });
    sessionDeliverableBindingStore.create({
      tenantId: 'tenant-beta',
      sessionId: betaSession.id,
      deliverableId: betaDeliverable.id,
    });

    expect(sessionDeliverableBindingStore.listBySession('tenant-alpha', alphaSession.id)).toHaveLength(1);
    expect(sessionDeliverableBindingStore.listBySession('tenant-beta', alphaSession.id)).toEqual([]);
    expect(sessionDeliverableBindingStore.remove('tenant-beta', alphaSession.id, alphaDeliverable.id)).toBe(false);
    expect(sessionDeliverableBindingStore.listDeliverablesForSession({
      tenantId: 'tenant-alpha',
      userId: 'user-alpha',
      sessionId: alphaSession.id,
    })).toEqual([expect.objectContaining({
      deliverableId: alphaDeliverable.id,
      title: 'Alpha report',
      version: 3,
    })]);
    expect(sessionDeliverableBindingStore.listDeliverablesForSession({
      tenantId: 'tenant-alpha',
      userId: 'user-beta',
      sessionId: alphaSession.id,
    })).toEqual([]);
  });
});
