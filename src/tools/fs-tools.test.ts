import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync, realpathSync } from 'node:fs';
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
  it('reads back a Full Access write to the configured workspace for a UUID user', async () => {
    const context: ToolContext = {
      tenantId: 'default',
      userId: '08adcd45-6f72-43ed-b08a-b3713209ee54',
      agentId: 'test-agent',
      permissionLevel: 'L3_FULL_ACCESS',
    };
    const path = `${tmpDir}/ashare_20260805/env_probe.json`;
    const content = '{"is_trading_day":true}';

    const written = await executeFsTool('write_file', { path, content }, 'call_write_legacy_workspace', context);
    const read = await executeFsTool('read_file', { path }, 'call_read_legacy_workspace', context);

    expect(written).toMatchObject({ is_error: false });
    expect(read).toMatchObject({ is_error: false, content });
    expect(realpathSync(written!.file_path!)).toBe(realpathSync(path));
    expect(realpathSync(read!.file_path!)).toBe(realpathSync(path));
  });

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
    expect(open.artifact.persisted_path).toBe(result?.file_path);
    expect(open.artifact.data.persisted_path).toBe(result?.file_path);
    const completedPatch = events.find((e): e is Extract<ArtifactEvent, { type: 'patch' }> => (
      e.type === 'patch' && e.patch.status === 'completed'
    ));
    expect(completedPatch?.artifactId).toBe(open.artifact.id);
    expect(completedPatch?.patch.persisted_path).toBe(result?.file_path);
    expect(result?.artifact_verified).toBe(true);
  });

  it('writes staged HTML but does not publish it while deterministic blockers remain', async () => {
    const events: ArtifactEvent[] = [];
    const coordinator = new ArtifactCoordinator('turn-staged', (event) => events.push(event));
    const context: ToolContext = {
      tenantId: 'default',
      chatId: 'chat-staged',
      sessionId: 'sess-staged',
      artifactCoordinator: coordinator,
      turnRichArtifactPaths: new Set(),
    };
    const staged = '<!doctype html><script src="https://cdn.example/chart.js"></script><script>const DATA = FINAL_DATA_JSON_PLACEHOLDER;</script>';

    const result = await executeFsTool('write_file', { path: 'staged.html', content: staged }, 'call-staged', context);

    expect(result?.is_error).toBe(false);
    expect(result?.artifact_verified).toBe(false);
    expect(result?.content).toContain('staged, not published');
    expect(readFileSync(result!.file_path!, 'utf8')).toBe(staged);
    expect(events.some((event) => event.type === 'patch' && event.patch.status === 'completed')).toBe(false);
    expect(context.turnRichArtifactPaths).toEqual(new Set());
  });
});
