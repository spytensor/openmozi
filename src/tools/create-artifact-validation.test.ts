import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { executeRuntimeTool } from './runtime-tools.js';
import type { ArtifactEvent } from '../artifacts/types.js';
import type { ToolContext } from './types.js';

const hoisted = vi.hoisted(() => ({
  workspaceDir: '',
}));

vi.mock('../config/index.js', () => ({
  getConfig: () => ({
    workspace: { dir: hoisted.workspaceDir },
    tools: {
      loops: {
        max_iterations: 0,
        dag_max_iterations: 0,
        subagent_max_iterations: 0,
        max_failed_tool_batches: 5,
      },
      fs: {
        workspace_only: true,
        allow_project_root_read: true,
        additional_allowed_roots: [],
        granted_project_roots: [],
      },
    },
    security: { default_permission: 'L3_FULL_ACCESS', hard_gates: [] },
  }),
}));

let workspaceTmpDir: string;
let dbTmpDir: string;
let savedMoziHome: string | undefined;
let artifactEvents: ArtifactEvent[];

const toolContext: ToolContext = {
  chatId: 'artifact-validation-chat',
  sessionId: 'artifact-validation-session',
  tenantId: 'artifact-validation-tenant',
  userId: 'artifact-validation-user',
  onArtifact: (event) => {
    artifactEvents.push(event);
  },
};

beforeAll(() => {
  workspaceTmpDir = createTempDir();
  hoisted.workspaceDir = workspaceTmpDir;
  savedMoziHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = join(workspaceTmpDir, 'mozi-home');
  const db = setupTestDb();
  dbTmpDir = db.tmpDir;
});

beforeEach(() => {
  artifactEvents = [];
  getDb().exec('DELETE FROM artifact_versions');
  getDb().exec('DELETE FROM conversations');
});

afterAll(() => {
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
  teardownTestDb(dbTmpDir);
  removeTempDir(workspaceTmpDir);
});

function latestOpenedArtifact(): Extract<ArtifactEvent, { type: 'open' }> {
  const event = artifactEvents.find((candidate) => candidate.type === 'open');
  if (!event || event.type !== 'open') throw new Error('Missing open artifact event');
  return event;
}

describe('create_artifact validation', () => {
  it('coerces content to code and defaults missing content_type to markdown', async () => {
    const result = await executeRuntimeTool(
      'create_artifact',
      { title: 'Content Alias', content: '# Rendered from content' },
      'artifact-content-alias',
      toolContext,
    );

    expect(result?.is_error).toBe(false);
    const event = latestOpenedArtifact();
    expect(event.artifact.title).toBe('Content Alias');
    expect(event.artifact.data).toMatchObject({
      markdown: '# Rendered from content',
      content_type: 'markdown',
    });
    expect(artifactEvents).toContainEqual(expect.objectContaining({
      type: 'patch',
      patch: expect.objectContaining({ status: 'completed' }),
    }));
  });

  it('coerces name to title', async () => {
    const result = await executeRuntimeTool(
      'create_artifact',
      { name: 'Name Alias', content_type: 'markdown', code: '# Named artifact' },
      'artifact-name-alias',
      toolContext,
    );

    expect(result?.is_error).toBe(false);
    expect(latestOpenedArtifact().artifact.title).toBe('Name Alias');
  });

  it('corrects standalone HTML mislabeled as markdown before rendering and persistence', async () => {
    const html = '<!DOCTYPE html><html><body><h1>Leadership dashboard</h1></body></html>';
    const result = await executeRuntimeTool(
      'create_artifact',
      { title: 'Leadership Dashboard', content_type: 'markdown', code: html },
      'artifact-mislabeled-html',
      toolContext,
    );

    expect(result?.is_error).toBe(false);
    expect(result?.file_path).toMatch(/\.html$/);
    expect(readFileSync(result?.file_path as string, 'utf8')).toBe(html);
    const event = latestOpenedArtifact();
    expect(event.artifact.plugin_id).toBe('sandpack_v1');
    expect(event.artifact.data).toMatchObject({ code: html, content_type: 'html' });
    expect(event.artifact.data).not.toHaveProperty('markdown');
  });

  it('echoes received keys and types on validation failure', async () => {
    const result = await executeRuntimeTool(
      'create_artifact',
      { content_type: 42, markdown: '', count: 3 },
      'artifact-invalid',
      toolContext,
    );

    expect(result?.is_error).toBe(true);
    expect(result?.content).toContain('Received keys: [content_type, markdown, count]');
    expect(result?.content).toContain('types: content_type=number, markdown=string, count=number');
    expect(result?.content).toContain('Coercible aliases: content/markdown/text→code, name→title.');
  });

  it('keeps repeated invalid argument errors specific each time', async () => {
    for (let index = 0; index < 4; index++) {
      const result = await executeRuntimeTool(
        'create_artifact',
        { bogus: `value-${index}`, retries: index },
        `artifact-invalid-${index}`,
        toolContext,
      );
      expect(result?.is_error).toBe(true);
      expect(result?.content).toContain('Received keys: [bogus, retries]');
      expect(result?.content).toContain('types: bogus=string, retries=number');
    }
  });
});
