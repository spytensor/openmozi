import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { executeRuntimeTool, RUNTIME_TOOL_DEFINITIONS } from './runtime-tools.js';
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
      shell: {
        restricted: false,
        network_isolation: false,
        executor: 'native',
        docker_image: 'alpine:3.20',
        background_processes: {
          enabled: true,
          max_concurrent: 10,
          process_timeout_seconds: 3600,
          max_output_buffer_bytes: 10 * 1024 * 1024,
        },
      },
    },
    security: { default_permission: 'L3_FULL_ACCESS', hard_gates: [] },
  }),
}));

let workspaceTmpDir: string;
let dbTmpDir: string;
let savedMoziHome: string | undefined;

const toolContext: ToolContext = {
  chatId: 'artifact-chat',
  sessionId: 'artifact-session',
  tenantId: 'artifact-tenant',
  userId: 'artifact-user',
};

beforeAll(() => {
  workspaceTmpDir = createTempDir();
  hoisted.workspaceDir = workspaceTmpDir;
  savedMoziHome = process.env.MOZI_HOME;
  process.env.MOZI_HOME = join(workspaceTmpDir, 'mozi-home');
  process.env.MOZI_WORKSPACES = join(workspaceTmpDir, 'user-workspaces');
  const db = setupTestDb();
  dbTmpDir = db.tmpDir;
});

beforeEach(() => {
  getDb().exec('DELETE FROM artifact_versions');
  getDb().exec('DELETE FROM conversations');
});

afterAll(() => {
  delete process.env.MOZI_WORKSPACES;
  if (savedMoziHome === undefined) delete process.env.MOZI_HOME;
  else process.env.MOZI_HOME = savedMoziHome;
  teardownTestDb(dbTmpDir);
  removeTempDir(workspaceTmpDir);
});

function latestPersistedArtifact(): Record<string, unknown> {
  const row = getDb().prepare(`
    SELECT content
    FROM conversations
    WHERE tenant_id = ? AND chat_id = ? AND role = 'tool'
    ORDER BY id DESC
    LIMIT 1
  `).get(toolContext.tenantId, toolContext.chatId) as { content: string } | undefined;
  if (!row) throw new Error('Missing persisted artifact conversation row');
  return JSON.parse(row.content) as Record<string, unknown>;
}

function artifactVersions(artifactId: string): Array<{
  id: string;
  artifact_id: string;
  version_number: number;
  content: string;
  persisted_path: string;
  change_description: string | null;
}> {
  return getDb().prepare(`
    SELECT id, artifact_id, version_number, content, persisted_path, change_description
    FROM artifact_versions
    WHERE artifact_id = ?
    ORDER BY version_number ASC
  `).all(artifactId) as Array<{
    id: string;
    artifact_id: string;
    version_number: number;
    content: string;
    persisted_path: string;
    change_description: string | null;
  }>;
}

async function createMarkdownArtifact(content: string, callId: string) {
  return executeRuntimeTool(
    'create_artifact',
    {
      title: 'Iteration Notes',
      content_type: 'markdown',
      code: content,
      fallback_text: 'Iteration notes ready',
    },
    callId,
    toolContext,
  );
}

describe('runtime artifact versioning tools', () => {
  it('registers update_artifact in runtime tool definitions', () => {
    expect(RUNTIME_TOOL_DEFINITIONS.map(tool => tool.function.name)).toContain('update_artifact');
  });

  it('round-trips markdown create_artifact content through persisted disk path', async () => {
    const content = '# Round Trip\n\nThe markdown body must be readable from disk.';

    const result = await createMarkdownArtifact(content, 'call-create-round-trip');

    expect(result?.is_error).toBe(false);
    expect(result?.file_path).toBeTruthy();
    expect(existsSync(result!.file_path!)).toBe(true);
    expect(readFileSync(result!.file_path!, 'utf-8')).toBe(content);

    const artifact = latestPersistedArtifact();
    expect(artifact.persisted_path).toBe(result!.file_path);
    expect(artifact.version_number).toBe(1);
  });

  it('links same-session create_artifact calls with matching persisted_path as versions', async () => {
    await createMarkdownArtifact('# Version One\n\nOriginal body.', 'call-create-v1');
    const firstArtifact = latestPersistedArtifact();

    await createMarkdownArtifact('# Version Two\n\nUpdated body.', 'call-create-v2');
    const secondArtifact = latestPersistedArtifact();

    expect(secondArtifact.parent_id).toBe(firstArtifact.id);
    expect(secondArtifact.version_number).toBe(2);
    expect(secondArtifact.persisted_path).toBe(firstArtifact.persisted_path);

    const versions = artifactVersions(firstArtifact.id as string);
    expect(versions.map(version => version.version_number)).toEqual([1, 2]);
    expect(versions[1].content).toContain('Updated body.');
  });

  it('update_artifact creates a linked version row and persists new content to disk', async () => {
    const original = '# Update Me\n\nOriginal content.';
    await createMarkdownArtifact(original, 'call-update-base');
    const firstArtifact = latestPersistedArtifact();

    const updated = '# Update Me\n\nUpdated content.';
    const result = await executeRuntimeTool(
      'update_artifact',
      {
        artifact_id: firstArtifact.id,
        new_content: updated,
        change_description: 'Replace original content',
      },
      'call-update-v2',
      toolContext,
    );

    expect(result?.is_error).toBe(false);
    expect(result?.file_path).toBe(firstArtifact.persisted_path);
    expect(readFileSync(result!.file_path!, 'utf-8')).toBe(updated);

    const returnedArtifact = JSON.parse(result!.content) as Record<string, unknown>;
    expect(returnedArtifact.parent_id).toBe(firstArtifact.id);
    expect(returnedArtifact.version_number).toBe(2);

    const versions = artifactVersions(firstArtifact.id as string);
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({
      artifact_id: firstArtifact.id,
      version_number: 2,
      content: updated,
      persisted_path: firstArtifact.persisted_path,
      change_description: 'Replace original content',
    });
  });

  it('preserves unchanged paragraphs across an artifact iteration', async () => {
    const turnOne = [
      '# Product Brief',
      'Paragraph 1: keep the customer problem exactly as written.',
      'Paragraph 2: replace this implementation detail.',
      'Paragraph 3: keep the launch criteria exactly as written.',
    ].join('\n\n');
    await createMarkdownArtifact(turnOne, 'call-iteration-v1');
    const firstArtifact = latestPersistedArtifact();

    const turnTwo = turnOne.replace(
      'Paragraph 2: replace this implementation detail.',
      'Paragraph 2: updated implementation detail only.',
    );
    const result = await executeRuntimeTool(
      'update_artifact',
      {
        artifact_id: firstArtifact.id,
        new_content: turnTwo,
        change_description: 'Edit paragraph 2 only',
      },
      'call-iteration-v2',
      toolContext,
    );

    expect(result?.is_error).toBe(false);
    const returnedArtifact = JSON.parse(result!.content) as Record<string, unknown>;
    expect(returnedArtifact.parent_id).toBe(firstArtifact.id);
    expect(returnedArtifact.version_number).toBe(2);

    const versions = artifactVersions(firstArtifact.id as string);
    expect(versions).toHaveLength(2);
    expect(versions.map(version => version.version_number)).toEqual([1, 2]);
    expect(versions[0]).toMatchObject({
      id: firstArtifact.id,
      artifact_id: firstArtifact.id,
      content: turnOne,
      persisted_path: firstArtifact.persisted_path,
    });
    expect(versions[1]).toMatchObject({
      artifact_id: firstArtifact.id,
      content: turnTwo,
      persisted_path: firstArtifact.persisted_path,
      change_description: 'Edit paragraph 2 only',
    });

    const persistedContent = readFileSync(result!.file_path!, 'utf-8');
    expect(persistedContent).toBe(turnTwo);
    expect(versions[1].content).toContain('Paragraph 1: keep the customer problem exactly as written.');
    expect(versions[1].content).toContain('Paragraph 2: updated implementation detail only.');
    expect(versions[1].content).toContain('Paragraph 3: keep the launch criteria exactly as written.');
    expect(versions[1].content).not.toContain('Paragraph 2: replace this implementation detail.');
  });
});

describe('runtime managed scheduler tools', () => {
  it('persists a managed Brain schedule with real identity and a deterministic receipt', async () => {
    const context: ToolContext = {
      chatId: 'local-user:sess-scheduler',
      sessionId: 'sess-scheduler',
      tenantId: 'artifact-tenant',
      userId: 'artifact-user',
      channelType: 'websocket',
      permissionLevel: 'L2_WRITE',
      userPrompt: '每天收盘后生成 A 股复盘 dashboard',
    };
    const result = await executeRuntimeTool('set_cron_task', {
      schedule_kind: 'cron',
      schedule_value: '15 15 * * 1-5',
      timezone: 'Asia/Shanghai',
      handler_type: 'managed_brain',
      handler_params: {
        prompt: '搜索当日 A 股收盘数据，验证交易日期后生成 dashboard。',
        timeout_minutes: 200,
      },
      description: 'A 股收盘复盘',
    }, 'call-managed-cron', context);

    expect(result).toMatchObject({ is_error: false, ends_turn: true });
    expect(result?.content).toContain('MOZI 定时任务已创建');
    expect(result?.content).toMatch(/ID：cron_/);
    expect(result?.content).toContain('Asia/Shanghai');
    const row = getDb().prepare(`
      SELECT chat_id, user_id, session_id, channel_type, permission_level, handler_type, handler_params
      FROM cron_tasks WHERE tenant_id = ? AND description = ?
    `).get(context.tenantId, 'A 股收盘复盘') as Record<string, string>;
    expect(row).toMatchObject({
      chat_id: context.chatId,
      user_id: context.userId,
      session_id: context.sessionId,
      channel_type: context.channelType,
      permission_level: context.permissionLevel,
      handler_type: 'managed_brain',
    });
    expect(JSON.parse(row.handler_params)).toMatchObject({
      prompt: '搜索当日 A 股收盘数据，验证交易日期后生成 dashboard。',
      source_request: context.userPrompt,
      timeout_minutes: 120,
    });
  });

  it('rejects managed schedules without a future workload prompt', async () => {
    const result = await executeRuntimeTool('set_cron_task', {
      schedule_kind: 'cron',
      schedule_value: '15 15 * * 1-5',
      timezone: 'Asia/Shanghai',
      handler_type: 'managed_brain',
      handler_params: {},
      description: 'Missing workload',
    }, 'call-managed-cron-invalid', {
      chatId: 'chat', sessionId: 'session', tenantId: 'default', userId: 'user', channelType: 'websocket',
      permissionLevel: 'L1_READ_WRITE',
    });
    expect(result).toMatchObject({ is_error: true });
    expect(result?.content).toContain('handler_params.prompt');
  });
});
