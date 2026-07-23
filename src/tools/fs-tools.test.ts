import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTempDir, removeTempDir } from '../test-helpers.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import { ArtifactCoordinator } from '../artifacts/coordinator.js';
import type { ToolContext } from './types.js';

const hoisted = vi.hoisted(() => ({
  fsWorkspaceOnly: true,
  allowProjectRootRead: true,
  additionalAllowedRoots: [] as string[],
}));

let tmpDir: string;

// Mock config to use our temp dir as workspace (mirrors executor.test.ts).
vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: tmpDir },
    tools: {
      loops: {
        max_iterations: 0,
        dag_max_iterations: 0,
        subagent_max_iterations: 0,
        max_failed_tool_batches: 5,
      },
      fs: {
        workspace_only: hoisted.fsWorkspaceOnly,
        allow_project_root_read: hoisted.allowProjectRootRead,
        additional_allowed_roots: hoisted.additionalAllowedRoots,
      },
    },
    security: { hard_gates: [] },
  }),
}));

// Stub only the DB-touching checkpoint helpers so the real filesystem write and
// TEL path still run without an initialized better-sqlite3 database.
vi.mock('./tool-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tool-utils.js')>();
  return {
    ...actual,
    createFileCheckpointHandle: () => null,
    finalizeFileCheckpoint: () => {},
    rollbackFileCheckpoint: () => {},
  };
});

import { executeFsTool } from './fs-tools.js';

// No DB setup: artifact persistence (saveMessage) is best-effort and its
// failure is caught+logged, so these tests exercise only the artifact-event
// emission path and do not depend on better-sqlite3.
beforeAll(() => {
  tmpDir = createTempDir();
});

afterAll(() => {
  removeTempDir(tmpDir);
});

describe('tools/fs-tools write_file artifact terminalization', () => {
  it('emits a terminal completed patch carrying plugin_id when reusing a pre-opened coordinator id, even for content <= 20 chars', async () => {
    const events: ArtifactEvent[] = [];
    const toolCallId = 'call_short_reuse';
    const coordinator = new ArtifactCoordinator('turn-1', (event) => events.push(event));
    const artifactId = coordinator.openOrGet(toolCallId, {
      plugin_id: 'live_work_v1',
      title: 'preview.html',
      content_type: 'html',
      status: 'running',
      fallback_text: 'Preparing live preview...',
      data: { content_type: 'html', live_preview: true },
    });
    const context: ToolContext = {
      tenantId: 'default',
      chatId: 'chat_1',
      sessionId: 'sess_1',
      artifactCoordinator: coordinator,
    };
    // 15 chars — below the historic length-20 gate that used to leave the card running.
    const short = '<p>hi there</p>';
    expect(short.length).toBeLessThanOrEqual(20);

    const result = await executeFsTool('write_file', { path: 'preview.html', content: short }, toolCallId, context);
    expect(result?.is_error).toBe(false);

    const patches = events.filter((e) => e.type === 'patch');
    const completedPatches = patches.filter((e) => e.type === 'patch' && e.patch.status === 'completed');
    expect(completedPatches.length).toBe(1);
    const patch = completedPatches[0];
    if (patch.type !== 'patch') throw new Error('expected patch event');
    expect(patch.artifactId).toBe(artifactId);
    expect(patch.patch.status).toBe('completed');
    expect(patch.patch.plugin_id).toBe('sandpack_v1');
    expect((patch.patch.data as Record<string, unknown>).code).toBe(short);
    expect(events.filter((e) => e.type === 'open')).toHaveLength(1);
  });

  it('does NOT open a brand-new card for a trivial write with no pre-opened hint', async () => {
    const events: ArtifactEvent[] = [];
    const context: ToolContext = {
      tenantId: 'default',
      chatId: 'chat_2',
      sessionId: 'sess_2',
    };
    const short = '<p>x</p>';
    expect(short.length).toBeLessThanOrEqual(20);

    const result = await executeFsTool('write_file', { path: 'trivial.html', content: short }, 'call_no_hint', context);
    expect(result?.is_error).toBe(false);
    expect(events.length).toBe(0);
  });

  it('opens a completed card for a non-trivial write with no pre-opened hint', async () => {
    const events: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator('turn-3', (event) => events.push(event));
    const context: ToolContext = {
      tenantId: 'default',
      chatId: 'chat_3',
      sessionId: 'sess_3',
      artifactCoordinator: coordinator,
    };
    const html = '<html><body><h1>A non-trivial document body</h1></body></html>';
    expect(html.length).toBeGreaterThan(20);

    const result = await executeFsTool('write_file', { path: 'big.html', content: html }, 'call_big', context);
    expect(result?.is_error).toBe(false);

    const opens = events.filter((e) => e.type === 'open');
    expect(opens.length).toBe(1);
    const open = opens[0];
    if (open.type !== 'open') throw new Error('expected open event');
    expect(open.artifact.status).toBe('running');
    expect(open.artifact.plugin_id).toBe('sandpack_v1');
    const completedPatch = events.find((e): e is Extract<ArtifactEvent, { type: 'patch' }> => (
      e.type === 'patch' && e.patch.status === 'completed'
    ));
    expect(completedPatch?.artifactId).toBe(open.artifact.id);
  });
});
