import { describe, expect, it } from 'vitest';
import { ArtifactCoordinator } from './coordinator.js';
import type { ArtifactEvent } from './types.js';

function eventsForCoordinator(turnId = 'turn-1', options: { documentRole?: 'primary' | 'workspace' } = {}): {
  events: ArtifactEvent[];
  coordinator: ArtifactCoordinator;
} {
  const events: ArtifactEvent[] = [];
  return {
    events,
    coordinator: new ArtifactCoordinator(turnId, (event) => events.push(event), options),
  };
}

describe('artifacts/coordinator', () => {
  it('converges live open and create_artifact completion by toolCallId', () => {
    const { events, coordinator } = eventsForCoordinator();
    const artifactId = coordinator.openOrGet('call-1', {
      plugin_id: 'live_work_v1',
      title: 'Generating artifact',
      content_type: 'markdown',
      status: 'running',
      fallback_text: 'Preparing live preview...',
      data: { content_type: 'markdown', live_preview: true },
    });

    expect(coordinator.openOrGet('call-1', {
      plugin_id: 'document_v1',
      title: 'Deck',
      content_type: 'markdown',
      status: 'running',
      fallback_text: 'Rendering preview...',
      data: { markdown: '# Deck', content_type: 'markdown' },
    })).toBe(artifactId);

    coordinator.complete('call-1', {
      plugin_id: 'document_v1',
      title: 'Deck',
      fallback_text: 'Deck ready',
      data: { markdown: '# Deck', content_type: 'markdown' },
    });

    const opens = events.filter((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    const completed = events.find((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
      event.type === 'patch' && event.patch.status === 'completed'
    ));

    expect(opens).toHaveLength(1);
    expect(opens[0].artifact.id).toBe(artifactId);
    expect(completed?.artifactId).toBe(artifactId);
    expect(completed?.patch.plugin_id).toBe('document_v1');
  });

  it('stamps document_v1 opens with the primary deliverable role (Issue #735)', () => {
    const { events, coordinator } = eventsForCoordinator();
    coordinator.openOrGet('call-doc', {
      plugin_id: 'document_v1',
      title: 'Report',
      content_type: 'markdown',
      data: { markdown: '# Report', content_type: 'markdown' },
    });

    const open = events.find((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    expect(open?.artifact.data.role).toBe('primary');
    // A still-running document is not a deliverable yet: the demotion latch it
    // feeds is one-way, so it must not fire for a document that may never
    // finish (pre-opened card whose tool errors, aborted stream).
    expect(coordinator.hasPrimaryDocument()).toBe(false);

    coordinator.complete('call-doc', { data: { markdown: '# Report', content_type: 'markdown' } });
    expect(coordinator.hasPrimaryDocument()).toBe(true);
  });

  it('stamps the role when a live placeholder converges to document_v1', () => {
    const { events, coordinator } = eventsForCoordinator();
    coordinator.openOrGet('call-live', {
      plugin_id: 'live_work_v1',
      title: 'Generating artifact',
      content_type: 'markdown',
      status: 'running',
      data: { content_type: 'markdown', live_preview: true },
    });
    coordinator.complete('call-live', {
      plugin_id: 'document_v1',
      title: 'Deck',
      data: { markdown: '# Deck', content_type: 'markdown' },
    });

    const completed = events.find((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
      event.type === 'patch' && event.patch.status === 'completed'
    ));
    expect((completed?.patch.data as Record<string, unknown> | undefined)?.role).toBe('primary');
    expect(coordinator.hasPrimaryDocument()).toBe(true);
  });

  it('stamps sandpack opens workspace in workspace mode; foreground sandpack stays role-less (G2)', () => {
    const workspace = eventsForCoordinator('turn-bg', { documentRole: 'workspace' });
    workspace.coordinator.openOrGet('call-page', {
      plugin_id: 'sandpack_v1',
      title: 'US Macro Dashboard',
      data: { files: { '/index.html': '<html/>' } },
    });
    const workspaceOpen = workspace.events.find((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    expect(workspaceOpen?.artifact.data.role).toBe('workspace');

    const foreground = eventsForCoordinator('turn-fg');
    foreground.coordinator.openOrGet('call-page', {
      plugin_id: 'sandpack_v1',
      title: 'Answer page',
      data: { files: { '/index.html': '<html/>' } },
    });
    const foregroundOpen = foreground.events.find((event): event is Extract<ArtifactEvent, { type: 'open' }> => event.type === 'open');
    expect(foregroundOpen?.artifact.data.role).toBeUndefined();
  });

  it('reports a completed rich renderable regardless of role mode (G2 file-curation signal)', () => {
    const { coordinator } = eventsForCoordinator('turn-bg', { documentRole: 'workspace' });
    expect(coordinator.hasCompletedRenderableArtifact()).toBe(false);
    coordinator.openOrGet('call-page', {
      plugin_id: 'sandpack_v1',
      title: 'Report page',
      status: 'running',
      data: { files: {} },
    });
    // Running pages do not count — mirror of the hasPrimaryDocument contract.
    expect(coordinator.hasCompletedRenderableArtifact()).toBe(false);
    coordinator.complete('call-page', { data: { files: { '/index.html': '<html/>' } } });
    expect(coordinator.hasCompletedRenderableArtifact()).toBe(true);
    // Workspace mode still shields the FILE primary latch (unchanged contract).
    expect(coordinator.hasPrimaryDocument()).toBe(false);
  });

  it('does not count running or failed documents as primary deliverables', () => {
    const { coordinator } = eventsForCoordinator();
    coordinator.openOrGet('call-doc', {
      plugin_id: 'document_v1',
      title: 'Aborted report',
      content_type: 'markdown',
      status: 'running',
      data: { markdown: '# partial', content_type: 'markdown' },
    });
    expect(coordinator.hasPrimaryDocument()).toBe(false);
    coordinator.complete('call-doc', { status: 'failed' });
    expect(coordinator.hasPrimaryDocument()).toBe(false);
  });

  it('keeps different toolCallIds as different deliverables', () => {
    const { events, coordinator } = eventsForCoordinator();
    const first = coordinator.openOrGet('create-call', {
      plugin_id: 'document_v1',
      title: 'Deck Notes',
      content_type: 'markdown',
      status: 'running',
      data: { markdown: '# Notes', content_type: 'markdown' },
    });
    const second = coordinator.openOrGet('write-call', {
      plugin_id: 'sandpack_v1',
      title: 'preview.html',
      content_type: 'html',
      status: 'running',
      data: { code: '<html></html>', content_type: 'html' },
    });

    expect(first).not.toBe(second);
    expect(events.filter((event) => event.type === 'open')).toHaveLength(2);
  });

  it('registers file writes and resolves output scans by path', () => {
    const { coordinator } = eventsForCoordinator();
    const artifactId = coordinator.openOrGet('write-pptx', {
      plugin_id: 'file_v1',
      title: 'deck.pptx',
      content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      status: 'running',
      data: { path: '/tmp/deck.pptx', filename: 'deck.pptx', content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
    });

    coordinator.registerFileWrite('write-pptx', '/tmp/deck.pptx');

    expect(coordinator.resolveByPath('/tmp/deck.pptx')).toBe(artifactId);
  });

  it('terminalizes open artifacts on success and error idempotently', () => {
    const { events, coordinator } = eventsForCoordinator();
    const successId = coordinator.openOrGet('success-call', {
      plugin_id: 'live_work_v1',
      title: 'Generating preview',
      content_type: 'html',
      status: 'running',
      data: { content_type: 'html', live_preview: true },
    });
    coordinator.terminateAll();
    coordinator.terminateAll();

    const successTerminals = events.filter((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
      event.type === 'patch' && event.artifactId === successId && event.patch.status === 'closed'
    ));
    expect(successTerminals).toHaveLength(1);

    const errorEvents: ArtifactEvent[] = [];
    const failedCoordinator = new ArtifactCoordinator('turn-2', (event) => errorEvents.push(event));
    const failedId = failedCoordinator.openOrGet('failed-call', {
      plugin_id: 'live_work_v1',
      title: 'Generating preview',
      content_type: 'html',
      status: 'running',
      data: { content_type: 'html', live_preview: true },
    });
    failedCoordinator.terminateAll('failed', 'Tool execution interrupted');
    failedCoordinator.terminateAll('failed', 'Tool execution interrupted');

    const failedTerminals = errorEvents.filter((event): event is Extract<ArtifactEvent, { type: 'patch' }> => (
      event.type === 'patch' && event.artifactId === failedId && event.patch.status === 'failed'
    ));
    expect(failedTerminals).toHaveLength(1);
    expect(failedTerminals[0].patch.fallback_text).toBe('Tool execution interrupted');
  });

  it('lists completed file deliverables (deduped, ignoring running and non-file artifacts)', () => {
    const { coordinator } = eventsForCoordinator('turn-deliverables');
    coordinator.openFileByPath('/out/OpenMoziDemo.docx', { plugin_id: 'file_v1', title: 'OpenMoziDemo.docx', status: 'completed', data: {} });
    coordinator.openFileByPath('/out/OpenMoziDemo.pptx', { plugin_id: 'file_v1', title: 'OpenMoziDemo.pptx', status: 'completed', data: {} });
    // Still running → excluded.
    coordinator.openOrGet('running-call', { plugin_id: 'file_v1', title: 'wip.pdf', status: 'running', data: {} });
    // Non-file kind → excluded.
    coordinator.openOrGet('live-call', { plugin_id: 'live_work_v1', title: 'preview', status: 'completed', data: {} });
    // Duplicate title of an already-listed deliverable → deduped.
    coordinator.openFileByPath('/out/dupe/OpenMoziDemo.docx', { plugin_id: 'file_v1', title: 'OpenMoziDemo.docx', status: 'completed', data: {} });

    expect(coordinator.completedDeliverableTitles()).toEqual(['OpenMoziDemo.docx', 'OpenMoziDemo.pptx']);
  });

  it('returns no deliverables for a turn that produced only running/failed files', () => {
    const { coordinator } = eventsForCoordinator('turn-empty');
    coordinator.openOrGet('c1', { plugin_id: 'file_v1', title: 'draft.docx', status: 'running', data: {} });
    coordinator.terminateAll('failed', 'interrupted');
    expect(coordinator.completedDeliverableTitles()).toEqual([]);
  });
});
