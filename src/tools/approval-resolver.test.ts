import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir, setupTestDb, teardownTestDb } from '../test-helpers.js';
import { getDb } from '../store/db.js';
import { createApprovalRequest, getRequest, listRequests, resetTableFlag } from '../security/gates.js';
import { createSession, getSessionPermissionLevel, getSessionScopeGrants } from '../memory/sessions.js';
import { assignRole } from '../security/rbac.js';
import { handleStructuredApprovalControlMessage, resolveClientText, type WsClient } from '../channels/websocket.js';
import { createMessageHandler } from '../index.js';
import { loadConfig } from '../config/index.js';
import { executeTool } from './executor.js';
import type { LLMClient, ToolCall } from '../core/llm.js';
import type { ToolContext } from './types.js';
import type { WebSocket } from 'ws';

const hoisted = vi.hoisted(() => ({
  workspaceDir: '',
}));

vi.mock('../config/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/index.js')>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.loadConfig(),
      workspace: { dir: hoisted.workspaceDir },
      tools: {
        ...actual.loadConfig().tools,
        fs: {
          workspace_only: true,
          allow_project_root_read: true,
          additional_allowed_roots: [],
          granted_project_roots: [],
        },
        shell: {
          ...actual.loadConfig().tools.shell,
          restricted: false,
          executor: 'native',
        },
      },
    }),
  };
});

let workspaceTmpDir: string;
let dbTmpDir: string;

const tenantId = 'tenant-approval-contract';
const userId = 'approval-user';

const client: WsClient = {
  id: 'ws-approval',
  userId,
  tenantId,
  username: 'approval-user',
  authenticated: true,
  capabilities: [],
};

const fallbackClient: LLMClient = {
  provider: 'test',
  async chat() {
    throw new Error('LLM should not be called for approval command tests');
  },
};

beforeAll(() => {
  workspaceTmpDir = createTempDir();
  hoisted.workspaceDir = workspaceTmpDir;
  const db = setupTestDb();
  dbTmpDir = db.tmpDir;
});

beforeEach(() => {
  resetTableFlag();
  createApprovalRequest('setup', 'setup', undefined, 'test', tenantId);
  getDb().exec('DELETE FROM approval_requests');
  getDb().exec('DELETE FROM sessions');
  assignRole(tenantId, userId, 'operator', 'test');
});

afterAll(() => {
  teardownTestDb(dbTmpDir);
  removeTempDir(workspaceTmpDir);
});

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call-${name}-${Date.now()}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function socketSink(): { socket: WebSocket; sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    socket: {
      send: (payload: string) => {
        sent.push(JSON.parse(payload) as unknown);
      },
    } as WebSocket,
  };
}

function createRequest(action: string, sessionId: string) {
  return createApprovalRequest(
    action,
    `${action} approval`,
    {
      sessionId,
      chatId: userId,
      userId,
      tenantId,
      target_path: join(workspaceTmpDir, 'outside', 'note.txt'),
      required_level: 'L1_READ_WRITE',
      current_level: 'L0_READ_ONLY',
      denied_action: 'filesystem.write',
      tool: 'write_file',
      tool_intent: 'note.txt',
    },
    'test',
    tenantId,
  );
}

async function approveViaCommand(requestId: string, scope: 'once' | 'session') {
  const { handler } = createMessageHandler(fallbackClient, new Date(), loadConfig(), () => null);
  return handler({
    chatId: userId,
    userId,
    username: userId,
    text: `/approve ${requestId} ${scope}`,
    isCommand: true,
    command: 'approve',
    commandArgs: `${requestId} ${scope}`,
    channelType: 'websocket',
    timestamp: new Date(),
    tenantId,
  });
}

describe('approval resolver contract', () => {
  for (const action of ['permission_elevation', 'path_scope_grant', 'write_confirmation']) {
    it(`WS structured approve preserves session grant contract for ${action}`, () => {
      const session = createSession(userId, `structured ${action}`, tenantId);
      const request = createRequest(action, session.id);
      const { socket } = socketSink();

      handleStructuredApprovalControlMessage({ type: 'approve', id: request.id, scope: 'session' }, client, socket);
      handleStructuredApprovalControlMessage({ type: 'approve', id: request.id, scope: 'session' }, client, socket);

      const resolved = getRequest(request.id, tenantId);
      expect(resolved?.status).toBe('approved');
      if (action === 'permission_elevation') {
        expect(getSessionPermissionLevel(session.id, tenantId)).toBe('L3_FULL_ACCESS');
      } else {
        expect(resolved?.context).toMatchObject({ grant_scope: 'session' });
      }
      expect(listRequests({ tenant_id: tenantId, action })).toHaveLength(1);
    });

    it(`WS slash fallback preserves session grant contract for ${action}`, async () => {
      const session = createSession(userId, `slash ${action}`, tenantId);
      const request = createRequest(action, session.id);
      const mapped = resolveClientText({ type: 'approve', id: request.id, scope: 'session' });
      expect(mapped).toEqual({ text: `/approve ${request.id} session` });

      await approveViaCommand(request.id, 'session');
      await approveViaCommand(request.id, 'session');

      const resolved = getRequest(request.id, tenantId);
      expect(resolved?.status).toBe('approved');
      if (action === 'permission_elevation') {
        expect(getSessionPermissionLevel(session.id, tenantId)).toBe('L3_FULL_ACCESS');
      } else {
        expect(resolved?.context).toMatchObject({ grant_scope: 'session' });
      }
      expect(listRequests({ tenant_id: tenantId, action })).toHaveLength(1);
    });

    it(`command handler parses once/session for ${action}`, async () => {
      const session = createSession(userId, `command ${action}`, tenantId);
      const request = createRequest(action, session.id);

      const output = await approveViaCommand(request.id, action === 'permission_elevation' ? 'once' : 'session');
      await approveViaCommand(request.id, action === 'permission_elevation' ? 'once' : 'session');

      expect(output).toContain(`Approved ${request.id}`);
      const resolved = getRequest(request.id, tenantId);
      expect(resolved?.status).toBe('approved');
      if (action === 'permission_elevation') {
        expect(getSessionPermissionLevel(session.id, tenantId)).toBe('L3_FULL_ACCESS');
      } else {
        expect(resolved?.context).toMatchObject({ grant_scope: 'session' });
      }
      expect(listRequests({ tenant_id: tenantId, action })).toHaveLength(1);
    });
  }

  it('one-time permission elevation is consumed by the pending tool call only', async () => {
    const session = createSession(userId, 'permission suppression', tenantId);
    const ctx: ToolContext = {
      agentId: `session:${session.id}`,
      permissionLevel: 'L0_READ_ONLY',
      tenantId,
      chatId: userId,
      sessionId: session.id,
      userId,
      taskId: 'permission-suppression',
    };
    const first = executeTool(toolCall('write_file', { path: 'elevated.txt', content: 'first' }), ctx);
    await vi.waitFor(() => expect(listRequests({ tenant_id: tenantId, action: 'permission_elevation' })).toHaveLength(1));
    const req = listRequests({ tenant_id: tenantId, action: 'permission_elevation' })[0];
    await approveViaCommand(req.id, 'once');
    await expect(first).resolves.toMatchObject({ is_error: false });

    expect(ctx.permissionLevel).toBe('L0_READ_ONLY');
    expect(ctx.permissionElevationRequests?.size).toBe(0);
  });

  it('session path scope grant suppresses a second prompt for the same directory', async () => {
    const session = createSession(userId, 'path suppression', tenantId);
    const projectDir = join(workspaceTmpDir, 'path-project');
    const outsideDir = join(workspaceTmpDir, 'path-session-grant');
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    const ctx: ToolContext = {
      agentId: `session:${session.id}`,
      permissionLevel: 'L2_SHELL_EXEC',
      tenantId,
      chatId: userId,
      sessionId: session.id,
      userId,
      taskId: 'path-suppression',
      workspaceRootPath: projectDir,
    };

    const first = executeTool(toolCall('write_file', { path: join(outsideDir, 'one.txt'), content: 'one' }), ctx);
    await vi.waitFor(() => expect(listRequests({ tenant_id: tenantId, action: 'path_scope_grant' })).toHaveLength(1));
    const req = listRequests({ tenant_id: tenantId, action: 'path_scope_grant' })[0];
    await approveViaCommand(req.id, 'session');
    await expect(first).resolves.toMatchObject({ is_error: false });
    expect(getSessionScopeGrants(session.id, tenantId)).toContain(outsideDir);

    const before = listRequests({ tenant_id: tenantId, action: 'path_scope_grant' }).length;
    const second = await executeTool(toolCall('write_file', { path: join(outsideDir, 'two.txt'), content: 'two' }), ctx);
    expect(second.is_error).toBe(false);
    expect(listRequests({ tenant_id: tenantId, action: 'path_scope_grant' })).toHaveLength(before);
  });

  it('session write confirmation suppresses a second L1 write prompt', async () => {
    const session = createSession(userId, 'write suppression', tenantId);
    const ctx: ToolContext = {
      agentId: `session:${session.id}`,
      permissionLevel: 'L1_READ_WRITE',
      tenantId,
      chatId: userId,
      sessionId: session.id,
      userId,
      taskId: 'write-suppression',
    };

    const first = executeTool(toolCall('write_file', { path: 'write-one.txt', content: 'one' }), ctx);
    await vi.waitFor(() => expect(listRequests({ tenant_id: tenantId, action: 'write_confirmation' })).toHaveLength(1));
    const req = listRequests({ tenant_id: tenantId, action: 'write_confirmation' })[0];
    await approveViaCommand(req.id, 'session');
    await expect(first).resolves.toMatchObject({ is_error: false });
    expect(getSessionScopeGrants(session.id, tenantId)).toContain('__l1_write_granted__');

    const before = listRequests({ tenant_id: tenantId, action: 'write_confirmation' }).length;
    const second = await executeTool(toolCall('write_file', { path: 'write-two.txt', content: 'two' }), ctx);
    expect(second.is_error).toBe(false);
    expect(listRequests({ tenant_id: tenantId, action: 'write_confirmation' })).toHaveLength(before);
  });
});
