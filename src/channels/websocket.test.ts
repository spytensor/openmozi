import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import {
  broadcastToClients,
  broadcastProgressEvent,
  deliverAssistantMessage,
  broadcastStreamEvent,
  broadcastArtifactEvent,
  broadcastSessionUpdate,
  broadcastSessionListChanged,
  buildWorkerTaskProgressMessage,
  buildTurnStateTaskProgressMessages,
  getConnectedClients,
  handleStructuredApprovalControlMessage,
  parseWsMessage,
  createWsResponse,
  registerWebSocketRoute,
  resolveClientText,
  isDisabledUser,
  buildTypedErrorChatMessage,
  type WsClient,
} from './websocket.js';
import { createLocalUser, updateUserStatus } from '../security/users.js';
import { ModelNotAllowedError, QuotaExceededError } from '../security/entitlements.js';
import { getSessionTimeline, saveTimelineItem } from '../memory/session-timeline.js';
import { startTurnEnvelope, setTurnEnvelopeStatus, getTurnEnvelope } from '../memory/turn-envelopes.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { createApprovalRequest, getRequest, resetTableFlag as resetApprovalTableFlag } from '../security/gates.js';
import { waitForApprovalDecision } from '../security/approval-wait.js';
import { assignRole } from '../security/rbac.js';
import {
  createSession,
  getSessionPermissionLevel,
  updateSessionPermissionLevel,
} from '../memory/sessions.js';
import { sign as signJwt } from '../security/jwt.js';
import type { WebSocket } from 'ws';
import { finishRunningTurn, registerRunningTurn } from '../core/turn-cancellation.js';
import { addBackgroundTask, getTask } from '../core/background-tasks.js';

describe('channels/websocket', () => {
  const mockClient: WsClient = {
    id: 'ws-test-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    username: 'testuser',
    authenticated: true,
    capabilities: [],
  };

  describe('parseWsMessage', () => {
    it('parses regular text message', () => {
      const msg = parseWsMessage('Hello world', mockClient);

      expect(msg.channelType).toBe('websocket');
      expect(msg.chatId).toBe('user-1:ws-test-1');
      expect(msg.userId).toBe('user-1');
      expect(msg.tenantId).toBe('tenant-1');
      expect(msg.username).toBe('testuser');
      expect(msg.text).toBe('Hello world');
      expect(msg.isCommand).toBe(false);
      expect(msg.command).toBeUndefined();
      expect(msg.timestamp).toBeInstanceOf(Date);
    });

    it('parses command with args', () => {
      const msg = parseWsMessage('/config set key value', mockClient);

      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('config');
      expect(msg.commandArgs).toBe('set key value');
    });

    it('parses command without args', () => {
      const msg = parseWsMessage('/status', mockClient);

      expect(msg.isCommand).toBe(true);
      expect(msg.command).toBe('status');
      expect(msg.commandArgs).toBeUndefined();
    });
  });

  describe('resolveClientText', () => {
    it('returns plain content for message type', () => {
      const result = resolveClientText({ type: 'message', content: 'hello' });
      expect(result).toEqual({ text: 'hello' });
    });

    it('returns null for empty message content', () => {
      const result = resolveClientText({ type: 'message', content: '   ' });
      expect(result).toBeNull();
    });

    it('maps approve to slash command', () => {
      const result = resolveClientText({ type: 'approve', id: 'req-123' });
      expect(result).toEqual({ text: '/approve req-123' });
    });

    it('maps reject to slash command', () => {
      const result = resolveClientText({ type: 'reject', id: 'req-456' });
      expect(result).toEqual({ text: '/reject req-456' });
    });

    it('returns error when approve/reject lacks id', () => {
      const result = resolveClientText({ type: 'approve' });
      expect(result).toEqual({ error: 'Missing request id for "approve"' });
    });

    it('does not convert cancel_turn control messages into chat text', () => {
      const result = resolveClientText({ type: 'cancel_turn' } as any);
      expect(result).toBeNull();
    });
  });

  describe('structured approval control messages', () => {
    let tmpDir: string;

    beforeEach(() => {
      const db = setupTestDb();
      tmpDir = db.tmpDir;
      resetApprovalTableFlag();
      assignRole('tenant-1', 'user-1', 'operator');
    });

    afterEach(() => {
      teardownTestDb(tmpDir);
    });

    function captureSocket(): { socket: WebSocket; sent: unknown[] } {
      const sent: unknown[] = [];
      const socket = {
        send: (payload: string) => {
          sent.push(JSON.parse(payload));
        },
      } as unknown as WebSocket;
      return { socket, sent };
    }

    it('resolves a pending approval without entering the busy session handler', async () => {
      const session = createSession('user-1', 'Needs search approval', 'tenant-1');
      updateSessionPermissionLevel(session.id, 'L1_READ_WRITE', 'tenant-1');
      const req = createApprovalRequest(
        'permission_elevation',
        'Raise this session for network search',
        {
          sessionId: session.id,
          chatId: 'user-1',
          current_level: 'L1_READ_WRITE',
          required_level: 'L3_FULL_ACCESS',
          denied_action: 'network.request',
          tool: 'web_search',
          tool_intent: 'search current facts',
          originating_prompt: 'look this up',
        },
        'session:test',
        'tenant-1',
      );
      const wait = waitForApprovalDecision(req.id, { timeoutMs: 10_000 });
      const busyHandler = vi.fn(() => new Promise<string | null>(() => {}));
      const { socket, sent } = captureSocket();

      handleStructuredApprovalControlMessage({ type: 'approve', id: req.id }, mockClient, socket);

      await expect(wait).resolves.toBe('approved');
      expect(busyHandler).not.toHaveBeenCalled();
      expect(getSessionPermissionLevel(session.id, 'tenant-1')).toBe('L3_FULL_ACCESS');
      expect(sent).toContainEqual(expect.objectContaining({
        type: 'approval_resolved',
        id: req.id,
        status: 'approved',
        permission_level: 'L3_FULL_ACCESS',
        sessionId: session.id,
      }));
      const timeline = getSessionTimeline(session.id, 10, 'tenant-1');
      expect(timeline).toHaveLength(1);
      expect(timeline[0].data).toMatchObject({ id: req.id, status: 'approved' });
    });

    it('treats a double approve as an idempotent terminal ack', () => {
      const session = createSession('user-1', 'Double approve', 'tenant-1');
      const req = createApprovalRequest(
        'external_comm',
        'Send external update',
        { sessionId: session.id, chatId: 'user-1' },
        'session:test',
        'tenant-1',
      );
      const { socket, sent } = captureSocket();

      handleStructuredApprovalControlMessage({ type: 'approve', id: req.id }, mockClient, socket);
      handleStructuredApprovalControlMessage({ type: 'approve', id: req.id }, mockClient, socket);

      expect(sent.filter((msg) => (msg as { type?: string }).type === 'error')).toHaveLength(0);
      expect(sent[sent.length - 1]).toMatchObject({
        type: 'approval_resolved',
        id: req.id,
        status: 'approved',
      });
    });

    it('passes session grant scope from structured approve messages into request context', () => {
      const session = createSession('user-1', 'Scope approve', 'tenant-1');
      const req = createApprovalRequest(
        'path_scope_grant',
        'Write outside project scope',
        { sessionId: session.id, chatId: 'user-1', target_dir: '/tmp/outside' },
        'session:test',
        'tenant-1',
      );
      const { socket } = captureSocket();

      handleStructuredApprovalControlMessage(
        { type: 'approve', id: req.id, scope: 'session' },
        mockClient,
        socket,
      );

      expect(getRequest(req.id, 'tenant-1')?.context).toMatchObject({ grant_scope: 'session' });
    });
  });

  describe('createWsResponse (legacy)', () => {
    it('creates message response', () => {
      const json = createWsResponse('message', 'Hello');
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe('message');
      expect(parsed.text).toBe('Hello');
      expect(parsed.timestamp).toBeTruthy();
    });

    it('creates error response', () => {
      const json = createWsResponse('error', 'Something went wrong');
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe('error');
      expect(parsed.text).toBe('Something went wrong');
    });

    it('creates response with data', () => {
      const json = createWsResponse('task_progress', undefined, {
        task_id: 'task-1',
        progress: 50,
      });
      const parsed = JSON.parse(json);

      expect(parsed.type).toBe('task_progress');
      expect(parsed.data).toEqual({ task_id: 'task-1', progress: 50 });
    });
  });

  describe('buildTypedErrorChatMessage', () => {
    it('surfaces model entitlement denials as assistant chat messages', () => {
      const msg = buildTypedErrorChatMessage(
        new ModelNotAllowedError('tenant-1', 'user-1', 'gpt-4.1', ['gpt-4.1-mini']),
        'session-1',
      );
      expect(msg).toMatchObject({
        type: 'message',
        role: 'assistant',
        sessionId: 'session-1',
      });
      expect(msg?.type === 'message' ? msg.content : '').toContain('Allowed models: gpt-4.1-mini');
    });

    it('surfaces token quota denials as assistant chat messages', () => {
      const msg = buildTypedErrorChatMessage(new QuotaExceededError({
        tenantId: 'tenant-1',
        limit: 'daily',
        limitTokens: 100,
        usedTokens: 100,
        resetAt: '2026-07-05T00:00:00.000Z',
      }));
      expect(msg).toMatchObject({
        type: 'message',
        role: 'assistant',
      });
      expect(msg?.type === 'message' ? msg.content : '').toContain('daily limit 100 tokens');
    });

    it('keeps unrelated errors masked by the caller', () => {
      expect(buildTypedErrorChatMessage(new Error('secret stack detail'))).toBeNull();
    });
  });

  describe('buildWorkerTaskProgressMessage', () => {
    it('maps worker queued status to user-facing checking progress', () => {
      const msg = buildWorkerTaskProgressMessage({
        type: 'worker_status',
        chatId: 'user-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        taskId: 'task-1',
        jobId: 'job-1',
        adapterId: 'codex-cli',
        runtimeLabel: 'Codex',
        workerStatus: 'queued',
        lane: 'review',
        sandboxProfile: 'read-only',
        timestamp: 123,
      });

      expect(msg).toMatchObject({
        type: 'task_progress',
        task_id: 'task-1',
        jobId: 'job-1',
        status: 'pending',
        userStatus: 'checking',
        title: 'Checking task readiness',
        rawStatus: 'queued',
        lane: 'review',
        sandboxProfile: 'read-only',
        sessionId: 'session-1',
      });
    });

    it('preserves concrete worker failure summaries for blocked tasks', () => {
      const msg = buildWorkerTaskProgressMessage({
        type: 'worker_status',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'task-1',
        jobId: 'job-1',
        workerStatus: 'failed',
        summary: 'Managed worker preflight failed: adapter unavailable',
        timestamp: 456,
      });

      expect(msg).toMatchObject({
        status: 'failed',
        userStatus: 'blocked',
        title: 'Managed worker preflight failed: adapter unavailable',
        detail: 'Managed worker preflight failed: adapter unavailable',
      });
    });
  });

  describe('buildTurnStateTaskProgressMessages', () => {
    it('emits nothing for intermediate lifecycle states — no fabricated work steps', () => {
      // The Brain's real activity is surfaced by tool_event + streamed text. Turning
      // every turn into a fixed "received → planning → working → responding"
      // narrative is invented progress; these states must produce no UI steps.
      for (const turnState of ['QUEUED', 'PLANNING', 'EXECUTING', 'RESPONDING'] as const) {
        expect(buildTurnStateTaskProgressMessages({
          type: 'turn_state',
          chatId: 'user-1',
          turnId: 'turn-1',
          turnState,
          detail: 'x',
          timestamp: 100,
        })).toEqual([]);
      }
    });

    it('emits a single truthful terminal marker when the turn ends', () => {
      expect(buildTurnStateTaskProgressMessages({
        type: 'turn_state',
        chatId: 'user-1',
        sessionId: 'session-1',
        turnId: 'turn-1',
        turnState: 'DONE',
        timestamp: 300,
      })).toMatchObject([
        {
          type: 'task_progress',
          task_id: 'turn-1:responding',
          status: 'completed',
          userStatus: 'responding',
          sessionId: 'session-1',
        },
      ]);
    });

    it('surfaces a failed turn as a blocked marker', () => {
      expect(buildTurnStateTaskProgressMessages({
        type: 'turn_state',
        chatId: 'user-1',
        turnId: 'turn-1',
        turnState: 'FAILED',
        detail: 'boom',
        timestamp: 400,
      })).toMatchObject([
        {
          task_id: 'turn-1:failed',
          status: 'failed',
          userStatus: 'blocked',
          detail: 'boom',
        },
      ]);
    });
  });

  describe('isDisabledUser', () => {
    let tmpDir: string;

    beforeEach(() => {
      const db = setupTestDb();
      tmpDir = db.tmpDir;
    });

    afterEach(() => {
      teardownTestDb(tmpDir);
    });

    it('rejects a disabled user even with a valid JWT payload', () => {
      const user = createLocalUser({
        tenant_id: 'default',
        email: 'disabled@example.com',
        password_hash: null,
        role: 'viewer',
      });
      updateUserStatus(user.id, 'default', 'disabled');
      expect(isDisabledUser({ sub: user.id, tenant_id: 'default' } as never)).toBe(true);
    });

    it('accepts an active user', () => {
      const user = createLocalUser({
        tenant_id: 'default',
        email: 'active@example.com',
        password_hash: null,
        role: 'viewer',
      });
      expect(isDisabledUser({ sub: user.id, tenant_id: 'default' } as never)).toBe(false);
    });

    it('does not reject identities without a users row', () => {
      expect(isDisabledUser({ sub: 'telegram-12345', tenant_id: 'default' } as never)).toBe(false);
    });
  });

  describe('tenant-scoped fan-out', () => {
    const jwtSecret = 'ws-test-secret';
    let tmpDir: string;
    let app: ReturnType<typeof Fastify>;
    const sockets: WebSocket[] = [];

    beforeEach(async () => {
      const db = setupTestDb();
      tmpDir = db.tmpDir;
      app = Fastify({ logger: false });
      await app.register(fastifyWebsocket);
      registerWebSocketRoute(app, async () => null, jwtSecret, { authMode: 'token' });
      await app.ready();
    });

    afterEach(async () => {
      for (const socket of sockets.splice(0)) {
        socket.terminate();
      }
      await app.close();
      teardownTestDb(tmpDir);
    });

    async function waitForCondition(condition: () => boolean, description: string): Promise<void> {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline) {
        if (condition()) return;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${description}`);
    }

    async function settleWsMessages(): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    function hasMessage(sent: unknown[], predicate: (msg: Record<string, unknown>) => boolean): boolean {
      return sent.some((msg) => {
        if (!msg || typeof msg !== 'object') return false;
        return predicate(msg as Record<string, unknown>);
      });
    }

    async function connectTenantClient(tenantId: string): Promise<{ socket: WebSocket; sent: unknown[] }> {
      const token = signJwt('local-user', jwtSecret, 3600, { tenant_id: tenantId, username: tenantId });
      const socket = await app.injectWS(`/ws?token=${encodeURIComponent(token)}`);
      const sent: unknown[] = [];
      sockets.push(socket);
      socket.on('message', (data) => {
        sent.push(JSON.parse(data.toString()));
      });
      socket.send(JSON.stringify({
        type: 'hello',
        client: 'vitest',
        capabilities: ['artifact_v1', 'execution_v1'],
      }));
      await waitForCondition(
        () => getConnectedClients().some(client => (
          client.userId === 'local-user'
          && client.tenantId === tenantId
          && client.capabilities.includes('artifact_v1')
          && client.capabilities.includes('execution_v1')
        )),
        `client capabilities for ${tenantId}`,
      );
      return { socket, sent };
    }

    async function connectSubscribedClient(
      tenantId: string,
      sessionId: string,
    ): Promise<{ socket: WebSocket; sent: unknown[] }> {
      const token = signJwt('local-user', jwtSecret, 3600, { tenant_id: tenantId, username: tenantId });
      const socket = await app.injectWS(`/ws?token=${encodeURIComponent(token)}`);
      const sent: unknown[] = [];
      sockets.push(socket);
      socket.on('message', (data) => sent.push(JSON.parse(data.toString())));
      socket.send(JSON.stringify({
        type: 'hello',
        client: 'vitest',
        capabilities: ['artifact_v1', 'execution_v1', 'session_subscription_v1'],
      }));
      socket.send(JSON.stringify({ type: 'select_session', sessionId }));
      await waitForCondition(
        () => hasMessage(sent, msg => msg.type === 'session_selected' && msg.sessionId === sessionId),
        `session selection for ${sessionId}`,
      );
      return { socket, sent };
    }

    it('rejects selecting another user session and keeps strict subscriptions isolated', async () => {
      const own = createSession('local-user', 'Own session', 'tenant-1');
      const other = createSession('other-user', 'Other session', 'tenant-1');
      const client = await connectSubscribedClient('tenant-1', own.id);
      client.sent.length = 0;

      client.socket.send(JSON.stringify({ type: 'select_session', sessionId: other.id }));
      await waitForCondition(
        () => hasMessage(client.sent, msg => msg.type === 'error' && msg.sessionId === other.id),
        'cross-user session rejection',
      );

      broadcastStreamEvent('stream_start', 'own-stream', undefined, 'local-user', own.id, 'tenant-1');
      await waitForCondition(
        () => hasMessage(client.sent, msg => msg.type === 'stream_start' && msg.requestId === 'own-stream'),
        'owned session stream',
      );
      broadcastStreamEvent('stream_start', 'other-stream', undefined, 'other-user', other.id, 'tenant-1');
      await settleWsMessages();
      expect(hasMessage(client.sent, msg => msg.type === 'stream_start' && msg.requestId === 'other-stream')).toBe(false);
    });

    it('falls back from foreground stop to the session-owned scheduled plan', async () => {
      const session = createSession('local-user', 'Scheduled work', 'tenant-1');
      const background = addBackgroundTask({
        tenantId: 'tenant-1', userId: 'local-user', sessionId: session.id,
        chatId: `local-user:${session.id}`, objective: 'Scheduled plan',
        handlerType: 'managed_brain', sourceCronTaskId: 'cron-session-stop',
      });
      const client = await connectSubscribedClient('tenant-1', session.id);
      client.sent.length = 0;

      client.socket.send(JSON.stringify({ type: 'cancel_turn', sessionId: session.id }));
      await waitForCondition(
        () => getTask(background.id)?.status === 'cancelled',
        'scheduled background cancellation',
      );
      expect(hasMessage(client.sent, msg => msg.type === 'error')).toBe(false);
    });

    it('still cancels the foreground turn before considering scheduled work', async () => {
      const session = createSession('local-user', 'Foreground work', 'tenant-1');
      const chatId = `local-user:${session.id}`;
      const background = addBackgroundTask({
        tenantId: 'tenant-1', userId: 'local-user', sessionId: session.id,
        chatId, objective: 'Later scheduled plan', handlerType: 'managed_brain',
        sourceCronTaskId: 'cron-foreground-regression',
      });
      const foreground = registerRunningTurn({
        turnId: 'turn-foreground', tenantId: 'tenant-1', chatId,
        userId: 'local-user', sessionId: session.id,
      });
      const client = await connectSubscribedClient('tenant-1', session.id);
      try {
        client.socket.send(JSON.stringify({ type: 'cancel_turn', sessionId: session.id }));
        await waitForCondition(() => foreground.signal.aborted, 'foreground cancellation');
        expect(getTask(background.id)?.status).toBe('pending');
      } finally {
        foreground.finish();
      }
    });

    it('restores the active turn for the selected canonical session chat key', async () => {
      const session = createSession('local-user', 'Running session', 'tenant-1');
      startTurnEnvelope({
        tenantId: 'tenant-1', sessionId: session.id, chatId: `local-user:${session.id}`,
        turnId: 'turn-session-live', origin: 'user', locale: 'zh-CN', startedAt: Date.now(),
      });
      const running = registerRunningTurn({
        turnId: 'turn-session-live',
        tenantId: 'tenant-1',
        chatId: `local-user:${session.id}`,
        userId: 'local-user',
        sessionId: session.id,
      });
      try {
        const client = await connectSubscribedClient('tenant-1', session.id);
        await waitForCondition(
          () => hasMessage(client.sent, msg => (
            msg.type === 'active_turn' && msg.turnId === 'turn-session-live' &&
            msg.sessionId === session.id && msg.locale === 'zh-CN'
          )),
          'selected active turn snapshot',
        );
      } finally {
        running.finish();
        finishRunningTurn('turn-session-live', 'tenant-1');
      }
    });

    it('hands a background turn its envelope live, without moving the session FSM (Issue #714)', async () => {
      const session = createSession('local-user', 'Plan session', 'tenant-1');
      const chatId = `local-user:${session.id}`;
      // The real shape: a detached plan's turn id is derived from its root task,
      // so it carries no epoch to fall back on.
      const bgTurnId = 'turn_bg_0c29b0f1-bb27-4455-b174-209ccb9aa446';
      const startedAt = 1784194733000;
      startTurnEnvelope({
        tenantId: 'tenant-1', sessionId: session.id, chatId,
        turnId: bgTurnId, origin: 'background', startedAt,
      });

      const client = await connectSubscribedClient('tenant-1', session.id);
      broadcastProgressEvent({
        type: 'turn_envelope_updated',
        tenantId: 'tenant-1',
        chatId,
        sessionId: session.id,
        turnId: bgTurnId,
        timestamp: Date.now(),
      });

      // Without this frame the client has no startedAt for the turn and orders it
      // by Number('bg') → NaN → MAX_SAFE_INTEGER, i.e. below later user messages.
      await waitForCondition(
        () => hasMessage(client.sent, msg => (
          msg.type === 'turn_envelope'
          && (msg.turn as Record<string, unknown> | undefined)?.turnId === bgTurnId
          && (msg.turn as Record<string, unknown> | undefined)?.startedAt === startedAt
          && (msg.turn as Record<string, unknown> | undefined)?.origin === 'background'
        )),
        'live background turn envelope',
      );

      // The FSM half of this contract ("a background turn must not emit
      // turn_state") is pinned in plan-runner.test.ts against the real bus.
      // Asserting it here would be decorative: this file never calls
      // broadcastWorkspaceEvent and never subscribes a workspace client, so the
      // assertion could not fail even if a background turn did move the FSM.
    });

    it('announces a self-minted background turn and its backfilled locale (Issue #714)', async () => {
      const session = createSession('local-user', 'Delivery session', 'tenant-1');
      const chatId = `local-user:${session.id}`;
      const client = await connectSubscribedClient('tenant-1', session.id);

      // No turnId: deliverAssistantMessage mints its own `turn_bg_*` envelope.
      // Its id has no epoch either, so an unannounced one sorts last forever.
      deliverAssistantMessage({
        tenantId: 'tenant-1', chatId, sessionId: session.id, content: '后台任务完成了。',
      });
      await waitForCondition(
        () => hasMessage(client.sent, msg => {
          const turn = msg.turn as Record<string, unknown> | undefined;
          return msg.type === 'turn_envelope'
            && typeof turn?.turnId === 'string'
            && (turn.turnId as string).startsWith('turn_bg_')
            && turn.origin === 'background'
            && turn.status === 'completed';
        }),
        'self-minted background turn envelope',
      );

      // The locale is COALESCE-backfilled here, after the plan runner already
      // announced. Without an announce of its own, a live client keeps an
      // envelope with no locale while a reload reports one — the same live-vs-
      // restore split #714 fixed for ordering.
      const planTurn = 'turn_bg_locale-backfill-root';
      startTurnEnvelope({
        tenantId: 'tenant-1', sessionId: session.id, chatId,
        turnId: planTurn, origin: 'background', startedAt: 1784194733000,
      });
      expect(getTurnEnvelope(session.id, planTurn, 'tenant-1')?.locale).toBeUndefined();

      deliverAssistantMessage({
        tenantId: 'tenant-1', chatId, sessionId: session.id,
        content: '这是一份中文的后台计划完成报告。', turnId: planTurn, origin: 'background',
      });
      await waitForCondition(
        () => hasMessage(client.sent, msg => {
          const turn = msg.turn as Record<string, unknown> | undefined;
          return msg.type === 'turn_envelope' && turn?.turnId === planTurn && turn?.locale === 'zh-CN';
        }),
        'announced locale backfill',
      );
    });

    it('broadcasts sidebar activity across sessions to the owner only and clears on terminal state', async () => {
      const visible = createSession('local-user', 'Visible', 'tenant-1');
      const background = createSession('local-user', 'Background', 'tenant-1');
      const owner = await connectSubscribedClient('tenant-1', visible.id);
      const otherTenant = await connectTenantClient('tenant-2');
      owner.sent.length = 0;
      otherTenant.sent.length = 0;

      startTurnEnvelope({
        tenantId: 'tenant-1', sessionId: background.id, chatId: 'local-user',
        turnId: 'turn-background', origin: 'background', startedAt: 1234,
      });
      broadcastProgressEvent({
        type: 'session_activity_changed', tenantId: 'tenant-1', sessionId: background.id,
        chatId: 'local-user', timestamp: Date.now(),
      });
      await waitForCondition(() => hasMessage(owner.sent, msg => (
        msg.type === 'session_activity' && msg.sessionId === background.id &&
        msg.status === 'running' && msg.startedAt === 1234
      )), 'cross-session owner activity');
      await settleWsMessages();
      expect(hasMessage(otherTenant.sent, msg => msg.type === 'session_activity' && msg.sessionId === background.id)).toBe(false);

      setTurnEnvelopeStatus({ tenantId: 'tenant-1', sessionId: background.id, turnId: 'turn-background', status: 'completed' });
      broadcastProgressEvent({
        type: 'session_activity_changed', tenantId: 'tenant-1', sessionId: background.id,
        chatId: 'local-user', timestamp: Date.now(),
      });
      await waitForCondition(() => hasMessage(owner.sent, msg => (
        msg.type === 'session_activity' && msg.sessionId === background.id && msg.status === null
      )), 'terminal activity clear');
    });

    it('broadcasts session-list changes to the owning user and tenant only', async () => {
      const owner = await connectTenantClient('tenant-1');
      const otherTenant = await connectTenantClient('tenant-2');
      owner.sent.length = 0;
      otherTenant.sent.length = 0;

      broadcastSessionListChanged({
        targetUserId: 'local-user', tenantId: 'tenant-1', sessionId: 'session-run',
      });

      await waitForCondition(() => hasMessage(owner.sent, msg => (
        msg.type === 'session_list_changed' && msg.sessionId === 'session-run'
      )), 'owner session-list change');
      await settleWsMessages();
      expect(hasMessage(otherTenant.sent, msg => msg.type === 'session_list_changed')).toBe(false);
    });

    it('isolates same-userId stream, artifact, session, progress, and direct broadcasts by tenant', async () => {
      const tenantA = await connectTenantClient('tenant-1');
      const tenantB = await connectTenantClient('tenant-2');
      const sessionA = createSession('local-user', 'Tenant A', 'tenant-1');
      const sessionB = createSession('local-user', 'Tenant B', 'tenant-2');
      tenantA.sent.length = 0;
      tenantB.sent.length = 0;

      broadcastStreamEvent('stream_start', 'stream-a', undefined, 'local-user', sessionA.id, 'tenant-1');
      await waitForCondition(() => hasMessage(tenantA.sent, msg => msg.type === 'stream_start' && msg.requestId === 'stream-a'), 'tenant A stream');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'stream_start' && msg.requestId === 'stream-a')).toBe(false);

      broadcastStreamEvent('stream_start', 'stream-b', undefined, 'local-user', sessionB.id, 'tenant-2');
      await waitForCondition(() => hasMessage(tenantB.sent, msg => msg.type === 'stream_start' && msg.requestId === 'stream-b'), 'tenant B stream');
      await settleWsMessages();
      expect(hasMessage(tenantA.sent, msg => msg.type === 'stream_start' && msg.requestId === 'stream-b')).toBe(false);

      broadcastArtifactEvent({
        type: 'open',
        artifact: {
          id: 'artifact-a',
          plugin_id: 'report',
          title: 'Tenant A artifact',
          status: 'running',
          collapsed_by_default: false,
          fallback_text: 'Tenant A artifact',
          data: {},
          updated_at: '2026-07-01T10:00:00.000Z',
        },
      }, 'local-user', sessionA.id, 'tenant-1');
      await waitForCondition(() => hasMessage(tenantA.sent, msg => msg.type === 'artifact_open' && (msg.artifact as { id?: string } | undefined)?.id === 'artifact-a'), 'tenant A artifact');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'artifact_open' && (msg.artifact as { id?: string } | undefined)?.id === 'artifact-a')).toBe(false);

      broadcastArtifactEvent({
        type: 'open',
        artifact: {
          id: 'artifact-b',
          plugin_id: 'report',
          title: 'Tenant B artifact',
          status: 'running',
          collapsed_by_default: false,
          fallback_text: 'Tenant B artifact',
          data: {},
          updated_at: '2026-07-01T10:00:01.000Z',
        },
      }, 'local-user', sessionB.id, 'tenant-2');
      await waitForCondition(() => hasMessage(tenantB.sent, msg => msg.type === 'artifact_open' && (msg.artifact as { id?: string } | undefined)?.id === 'artifact-b'), 'tenant B artifact');
      await settleWsMessages();
      expect(hasMessage(tenantA.sent, msg => msg.type === 'artifact_open' && (msg.artifact as { id?: string } | undefined)?.id === 'artifact-b')).toBe(false);

      broadcastSessionUpdate(sessionA.id, 'Tenant A updated');
      await waitForCondition(() => hasMessage(tenantA.sent, msg => msg.type === 'session_update' && msg.sessionId === sessionA.id), 'tenant A session update');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'session_update' && msg.sessionId === sessionA.id)).toBe(false);

      broadcastSessionUpdate(sessionB.id, 'Tenant B updated');
      await waitForCondition(() => hasMessage(tenantB.sent, msg => msg.type === 'session_update' && msg.sessionId === sessionB.id), 'tenant B session update');
      await settleWsMessages();
      expect(hasMessage(tenantA.sent, msg => msg.type === 'session_update' && msg.sessionId === sessionB.id)).toBe(false);

      broadcastProgressEvent({
        type: 'tool_call',
        tenantId: 'tenant-1',
        sessionId: sessionA.id,
        chatId: 'local-user',
        turnId: 'turn-a',
        toolName: 'shell',
        toolCallId: 'call-a',
        timestamp: Date.now(),
      });
      await waitForCondition(() => hasMessage(tenantA.sent, msg => msg.type === 'tool_event' && msg.callId === 'call-a'), 'tenant A tool event');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'tool_event' && msg.callId === 'call-a')).toBe(false);

      startTurnEnvelope({
        tenantId: 'tenant-1', sessionId: sessionA.id, chatId: 'local-user',
        turnId: 'turn-live-locale', origin: 'user', locale: 'zh-CN', startedAt: Date.now(),
      });
      broadcastProgressEvent({
        type: 'turn_state', tenantId: 'tenant-1', sessionId: sessionA.id,
        chatId: 'local-user', turnId: 'turn-live-locale', turnState: 'EXECUTING', timestamp: Date.now(),
      });
      await waitForCondition(() => hasMessage(tenantA.sent, msg => (
        msg.type === 'turn_envelope' &&
        (msg.turn as { turnId?: string; locale?: string } | undefined)?.turnId === 'turn-live-locale' &&
        (msg.turn as { locale?: string } | undefined)?.locale === 'zh-CN'
      )), 'tenant A live turn envelope locale');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'turn_envelope' &&
        (msg.turn as { turnId?: string } | undefined)?.turnId === 'turn-live-locale')).toBe(false);

      broadcastProgressEvent({
        type: 'tool_call',
        tenantId: 'tenant-2',
        sessionId: sessionB.id,
        chatId: 'local-user',
        turnId: 'turn-b',
        toolName: 'shell',
        toolCallId: 'call-b',
        timestamp: Date.now(),
      });
      await waitForCondition(() => hasMessage(tenantB.sent, msg => msg.type === 'tool_event' && msg.callId === 'call-b'), 'tenant B tool event');
      await settleWsMessages();
      expect(hasMessage(tenantA.sent, msg => msg.type === 'tool_event' && msg.callId === 'call-b')).toBe(false);

      broadcastProgressEvent({
        type: 'context_compression',
        tenantId: 'tenant-1',
        sessionId: sessionA.id,
        chatId: 'local-user',
        compressionStage: 'summarizing',
        sourceTokens: 70_000,
        contextWindow: 100_000,
        timestamp: Date.now(),
      });
      await waitForCondition(() => hasMessage(tenantA.sent, msg => msg.type === 'context_compression' && msg.sessionId === sessionA.id && msg.stage === 'summarizing'), 'tenant A context compression');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'context_compression' && msg.sessionId === sessionA.id)).toBe(false);

      broadcastToClients(app, 'message', 'tenant A direct', undefined, { userId: 'local-user', tenantId: 'tenant-1' });
      await waitForCondition(() => hasMessage(tenantA.sent, msg => msg.type === 'message' && msg.content === 'tenant A direct'), 'tenant A direct broadcast');
      await settleWsMessages();
      expect(hasMessage(tenantB.sent, msg => msg.type === 'message' && msg.content === 'tenant A direct')).toBe(false);

      broadcastToClients(app, 'message', 'tenant B direct', undefined, { userId: 'local-user', tenantId: 'tenant-2' });
      await waitForCondition(() => hasMessage(tenantB.sent, msg => msg.type === 'message' && msg.content === 'tenant B direct'), 'tenant B direct broadcast');
      await settleWsMessages();
      expect(hasMessage(tenantA.sent, msg => msg.type === 'message' && msg.content === 'tenant B direct')).toBe(false);
    });
  });

  describe('timeline persistence', () => {
    let tmpDir: string;

    beforeEach(() => {
      const db = setupTestDb();
      tmpDir = db.tmpDir;
      resetApprovalTableFlag();
    });

    afterEach(() => {
      vi.useRealTimers();
      teardownTestDb(tmpDir);
    });

    it('persists tool events as a single restorable timeline row', () => {
      broadcastProgressEvent({
        type: 'tool_call',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        toolName: 'browser_extract',
        toolCallId: 'call-1',
        intent: 'Collect page facts',
        timestamp: 100,
      });
      broadcastProgressEvent({
        type: 'tool_result',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        toolName: 'browser_extract',
        toolCallId: 'call-1',
        result: 'facts found',
        elapsed_ms: 35,
        skillName: 'imagegen',
        skillDescription: 'Generate images from prompts',
        skillLoadOutcome: 'success',
        timestamp: 300,
      });

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([
        {
          type: 'tool_event',
          timestamp: 100,
          data: {
            id: 'tool_call-1',
            callId: 'call-1',
            turnId: 'turn-1',
            tool: 'browser_extract',
            phase: 'end',
            status: 'success',
            intent: 'Collect page facts',
            result: 'facts found',
            elapsed_ms: 35,
            skillName: 'imagegen',
            skillDescription: 'Generate images from prompts',
            skillLoadOutcome: 'success',
            timestamp: 300,
          },
        },
      ]);
    });

    it('persists plan_started as a typed restorable timeline row (Issue #735)', () => {
      broadcastProgressEvent({
        type: 'plan_started',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'plan-root-1',
        taskTitle: 'Produce the quarterly report',
        planPhases: [
          { taskId: 'task-a', title: 'Collect data', dependsOn: [] },
          { taskId: 'task-b', title: 'Write report', dependsOn: ['task-a'] },
        ],
        locale: 'en',
        totalTasks: 2,
        timestamp: 100,
      });

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([
        {
          type: 'plan_started',
          timestamp: 100,
          data: {
            plan_id: 'plan-root-1',
            goal: 'Produce the quarterly report',
            phases: [
              { taskId: 'task-a', title: 'Collect data', dependsOn: [] },
              { taskId: 'task-b', title: 'Write report', dependsOn: ['task-a'] },
            ],
            locale: 'en',
            turnId: 'turn-1',
            timestamp: 100,
          },
        },
      ]);
    });

    it('persists a completed step result excerpt and keeps it through later frames without one', () => {
      // Write side of the plan-card step disclosure (operator report
      // 2026-07-19): task_completed carries the result excerpt; a later
      // frame on the same eventKey without a detail must not erase it.
      broadcastProgressEvent({
        type: 'task_completed',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'step-1',
        taskTitle: '计算总和',
        detail: '8+13+21+34 的总和为 76。',
        elapsed_ms: 900,
        timestamp: 100,
      });
      let rows = getSessionTimeline('session-1', 20, 'tenant-1');
      expect(rows).toHaveLength(1);
      expect(rows[0].data).toMatchObject({
        task_id: 'step-1',
        status: 'completed',
        rawStatus: 'task_completed',
        detail: '8+13+21+34 的总和为 76。',
      });

      // An out-of-order lifecycle frame with no detail merges without erasing.
      broadcastProgressEvent({
        type: 'task_started',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'step-1',
        taskTitle: '计算总和',
        timestamp: 150,
      });
      rows = getSessionTimeline('session-1', 20, 'tenant-1');
      expect(rows).toHaveLength(1);
      expect((rows[0].data as { detail?: string }).detail).toBe('8+13+21+34 的总和为 76。');
    });

    it('does not persist a detail for failed or cancelled task events', () => {
      // Failure details keep the existing policy (Technical details only) —
      // only the completion excerpt passes through this path.
      broadcastProgressEvent({
        type: 'task_failed',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'step-2',
        taskTitle: 'Build',
        error: 'compile error',
        detail: 'raw failure output that must not surface',
        timestamp: 100,
      });
      const rows = getSessionTimeline('session-1', 20, 'tenant-1');
      expect(rows).toHaveLength(1);
      expect((rows[0].data as { detail?: string }).detail).toBeUndefined();
      expect(rows[0].data).toMatchObject({ task_id: 'step-2', status: 'failed', rawStatus: 'task_failed' });
    });

    it('does not persist a plan_started event with no phases', () => {
      broadcastProgressEvent({
        type: 'plan_started',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'plan-root-empty',
        taskTitle: 'Empty plan',
        planPhases: [],
        timestamp: 100,
      });

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([]);
    });

    it('persists worker status updates without moving the original progress row', () => {
      broadcastProgressEvent({
        type: 'worker_status',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'task-1',
        jobId: 'job-1',
        adapterId: 'codex-cli',
        runtimeLabel: 'Codex',
        workerStatus: 'running',
        summary: 'Reading repository',
        timestamp: 100,
      });
      broadcastProgressEvent({
        type: 'worker_status',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        turnId: 'turn-1',
        taskId: 'task-1',
        jobId: 'job-1',
        adapterId: 'codex-cli',
        runtimeLabel: 'Codex',
        workerStatus: 'completed',
        summary: 'Repository checked',
        elapsed_ms: 400,
        timestamp: 500,
      });

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([
        {
          type: 'task_update',
          timestamp: 100,
          data: {
            id: 'task_task-1',
            task_id: 'task-1',
            jobId: 'job-1',
            turnId: 'turn-1',
            title: 'Repository checked',
            status: 'completed',
            userStatus: 'done',
            detail: 'Repository checked',
            rawStatus: 'completed',
            runtimeLabel: 'Codex',
            adapterId: 'codex-cli',
            elapsed_ms: 400,
            timestamp: 500,
          },
        },
      ]);
    });

    it('does not persist turn lifecycle markers — reloaded turns show only real work', () => {
      // Lifecycle markers are ephemeral session-state signals. Persisting them
      // resurrected a fabricated "planning/working" narrative on every reload.
      for (const [turnState, timestamp] of [
        ['PLANNING', 100],
        ['EXECUTING', 200],
        ['RESPONDING', 300],
        ['DONE', 400],
      ] as const) {
        broadcastProgressEvent({
          type: 'turn_state',
          tenantId: 'tenant-1',
          sessionId: 'session-1',
          chatId: 'user-1',
          turnId: 'turn-1',
          turnState,
          detail: 'x',
          timestamp,
        });
      }

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([]);
    });

    it('persists assistant stream lifecycle as one restorable message row', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T10:00:00.000Z'));

      broadcastStreamEvent('stream_start', 'stream-1', undefined, 'user-1', 'session-1', 'tenant-1');
      vi.setSystemTime(new Date('2026-07-01T10:00:01.000Z'));
      broadcastStreamEvent('stream_chunk', 'stream-1', 'partial answer', 'user-1', 'session-1', 'tenant-1');
      vi.setSystemTime(new Date('2026-07-01T10:00:02.000Z'));
      broadcastStreamEvent('stream_end', 'stream-1', 'final answer', 'user-1', 'session-1', 'tenant-1');

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([
        {
          type: 'message',
          timestamp: 1782900000000,
          data: {
            id: 'stream-1',
            role: 'assistant',
            content: 'final answer',
            timestamp: 1782900002000,
            streaming: false,
            requestId: 'stream-1',
          },
        },
      ]);
    });

    it('updates an approval row to a terminal status in place on resolve', () => {
      // Mirrors the WS approve/reject persistence: the pending row is re-saved
      // under the same event_key with the terminal status and the original
      // timestamp preserved, so a refresh restores approved/rejected in place.
      saveTimelineItem({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        type: 'approval_request',
        eventKey: 'approval:req-1',
        timestamp: 1000,
        data: { id: 'req-1', description: 'raise L1→L3', status: 'pending', timestamp: 1000 },
      });

      saveTimelineItem({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        type: 'approval_request',
        eventKey: 'approval:req-1',
        timestamp: 999999,
        preserveTimestampOnUpdate: true,
        data: { id: 'req-1', description: 'raise L1→L3', status: 'approved', timestamp: 1000 },
      });

      const items = getSessionTimeline('session-1', 20, 'tenant-1');
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('approval_request');
      expect(items[0].timestamp).toBe(1000);
      expect((items[0].data as { status: string }).status).toBe('approved');
    });

    it('persists approval_resolved progress events onto the approval row', () => {
      saveTimelineItem({
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        type: 'approval_request',
        eventKey: 'approval:req-2',
        timestamp: 1000,
        data: { id: 'req-2', description: 'raise L1→L3', status: 'pending', timestamp: 1000 },
      });

      broadcastProgressEvent({
        type: 'approval_resolved',
        tenantId: 'tenant-1',
        sessionId: 'session-1',
        chatId: 'user-1',
        approvalRequestId: 'req-2',
        approvalStatus: 'rejected',
        approvalAction: 'permission_elevation',
        description: 'raise L1→L3',
        currentLevel: 'L1_READ_WRITE',
        requiredLevel: 'L3_FULL_ACCESS',
        deniedAction: 'network.request',
        approvalTool: 'web_search',
        timestamp: 999999,
      });

      const items = getSessionTimeline('session-1', 20, 'tenant-1');
      expect(items).toHaveLength(1);
      expect(items[0].timestamp).toBe(1000);
      expect(items[0].data).toMatchObject({
        id: 'req-2',
        status: 'rejected',
        action: 'permission_elevation',
        tool: 'web_search',
      });
    });

    it('coalesces rapid stream chunks and never loses the final text', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T11:00:00.000Z'));

      const content = (): string | null => {
        const items = getSessionTimeline('session-1', 20, 'tenant-1');
        return items.length ? (items[0].data as { content: string }).content : null;
      };

      broadcastStreamEvent('stream_start', 'stream-fast', undefined, 'user-1', 'session-1', 'tenant-1');
      // Leading edge: the first chunk is delivered synchronously, no wait.
      broadcastStreamEvent('stream_chunk', 'stream-fast', 'A', 'user-1', 'session-1', 'tenant-1');
      expect(content()).toBe('A');

      // Within the coalesce window: intermediate frames are buffered, not delivered.
      broadcastStreamEvent('stream_chunk', 'stream-fast', 'AB', 'user-1', 'session-1', 'tenant-1');
      broadcastStreamEvent('stream_chunk', 'stream-fast', 'ABC', 'user-1', 'session-1', 'tenant-1');
      expect(content()).toBe('A');

      // Trailing edge flushes only the newest accumulated text — 'ABC', never 'AB'.
      vi.advanceTimersByTime(50);
      expect(content()).toBe('ABC');

      // stream_end supersedes any still-buffered chunk and marks the row final.
      broadcastStreamEvent('stream_chunk', 'stream-fast', 'ABCD', 'user-1', 'session-1', 'tenant-1');
      broadcastStreamEvent('stream_end', 'stream-fast', 'ABCDE', 'user-1', 'session-1', 'tenant-1');
      const finalItems = getSessionTimeline('session-1', 20, 'tenant-1');
      expect(finalItems).toHaveLength(1);
      expect((finalItems[0].data as { content: string; streaming: boolean }).content).toBe('ABCDE');
      expect((finalItems[0].data as { streaming: boolean }).streaming).toBe(false);

      // No stale trailing frame fires after the stream has ended.
      vi.advanceTimersByTime(200);
      expect(content()).toBe('ABCDE');
    });

    it('removes empty assistant stream placeholders from the persisted timeline', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T10:05:00.000Z'));

      broadcastStreamEvent('stream_start', 'stream-empty', undefined, 'user-1', 'session-1', 'tenant-1');
      broadcastStreamEvent('stream_chunk', 'stream-empty', 'partial response', 'user-1', 'session-1', 'tenant-1');
      broadcastStreamEvent('stream_end', 'stream-empty', '', 'user-1', 'session-1', 'tenant-1');

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([]);
    });

    it('persists artifact open and patch events as one restorable artifact row', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T10:10:00.000Z'));

      broadcastArtifactEvent({
        type: 'open',
        artifact: {
          id: 'artifact-1',
          plugin_id: 'report',
          title: 'Runtime report',
          status: 'running',
          collapsed_by_default: false,
          fallback_text: 'Runtime report',
          data: { step: 1, summary: 'collecting' },
          updated_at: '2026-07-01T10:10:00.000Z',
        },
      }, 'user-1', 'session-1', 'tenant-1');
      vi.setSystemTime(new Date('2026-07-01T10:10:05.000Z'));
      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-1',
        patch: { status: 'completed', data: { step: 2 }, summary: 'complete' } as any,
      }, 'user-1', 'session-1', 'tenant-1');

      expect(getSessionTimeline('session-1', 20, 'tenant-1')).toEqual([
        {
          type: 'artifact',
          timestamp: 1782900600000,
          data: {
            id: 'artifact-1',
            plugin_id: 'report',
            title: 'Runtime report',
            status: 'completed',
            fallback_text: 'Runtime report',
            data: { step: 2, summary: 'complete' },
            timestamp: 1782900600000,
          },
        },
      ]);
    });

    it('throttles running artifact patch persistence but always persists terminal patch content', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T10:20:00.000Z'));

      const persistedArtifact = () => (
        getSessionTimeline('session-1', 20, 'tenant-1')[0]?.data as any
      );

      broadcastArtifactEvent({
        type: 'open',
        artifact: {
          id: 'artifact-throttle',
          plugin_id: 'live_work_v1',
          title: 'Live preview',
          status: 'running',
          collapsed_by_default: false,
          fallback_text: 'Preparing',
          data: { content_type: 'html', live_preview: true },
          updated_at: '2026-07-01T10:20:00.000Z',
        },
      }, 'user-1', 'session-1', 'tenant-1');

      vi.setSystemTime(new Date('2026-07-01T10:20:00.100Z'));
      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-throttle',
        patch: { status: 'running', data: { code: 'rapid-1', content_type: 'html' } },
      }, 'user-1', 'session-1', 'tenant-1');
      expect(persistedArtifact().data.code).toBeUndefined();

      vi.setSystemTime(new Date('2026-07-01T10:20:00.600Z'));
      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-throttle',
        patch: { status: 'running', data: { code: 'persisted-window', content_type: 'html' } },
      }, 'user-1', 'session-1', 'tenant-1');
      expect(persistedArtifact().data.code).toBe('persisted-window');

      vi.setSystemTime(new Date('2026-07-01T10:20:00.650Z'));
      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-throttle',
        patch: { status: 'running', data: { code: 'rapid-2', content_type: 'html' } },
      }, 'user-1', 'session-1', 'tenant-1');
      expect(persistedArtifact().data.code).toBe('persisted-window');

      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-throttle',
        patch: { status: 'failed', fallback_text: 'Generation failed', data: { phase: 'failed' } },
      }, 'user-1', 'session-1', 'tenant-1');
      expect(persistedArtifact().status).toBe('failed');
      expect(persistedArtifact().data.code).toBe('rapid-2');
      expect(persistedArtifact().data.phase).toBe('failed');
    });

    it('flushes the last throttled patch to the timeline when the artifact closes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T12:00:00.000Z'));

      const persistedArtifact = () => (
        getSessionTimeline('session-close', 20, 'tenant-1')[0]?.data as any
      );

      broadcastArtifactEvent({
        type: 'open',
        artifact: {
          id: 'artifact-close',
          plugin_id: 'live_work_v1',
          title: 'Live preview',
          status: 'running',
          collapsed_by_default: false,
          fallback_text: 'Preparing',
          data: {},
          updated_at: '2026-07-01T12:00:00.000Z',
        },
      }, 'user-1', 'session-close', 'tenant-1');

      // Within the throttle window: stashed as pending, not yet on disk.
      vi.setSystemTime(new Date('2026-07-01T12:00:00.100Z'));
      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-close',
        patch: { status: 'running', data: { code: 'pending-frame' } },
      }, 'user-1', 'session-close', 'tenant-1');
      expect(persistedArtifact().data.code).toBeUndefined();

      // Close must flush the pending frame instead of dropping it.
      broadcastArtifactEvent({
        type: 'close',
        artifactId: 'artifact-close',
      }, 'user-1', 'session-close', 'tenant-1');
      expect(persistedArtifact().data.code).toBe('pending-frame');
    });

    it('persists a throttled running patch on the trailing edge after the throttle window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-01T13:00:00.000Z'));

      const persistedArtifact = () => (
        getSessionTimeline('session-trailing', 20, 'tenant-1')[0]?.data as any
      );

      broadcastArtifactEvent({
        type: 'open',
        artifact: {
          id: 'artifact-trailing',
          plugin_id: 'live_work_v1',
          title: 'Live preview',
          status: 'running',
          collapsed_by_default: false,
          fallback_text: 'Preparing',
          data: {},
          updated_at: '2026-07-01T13:00:00.000Z',
        },
      }, 'user-1', 'session-trailing', 'tenant-1');

      vi.setSystemTime(new Date('2026-07-01T13:00:00.100Z'));
      broadcastArtifactEvent({
        type: 'patch',
        artifactId: 'artifact-trailing',
        patch: { status: 'running', data: { code: 'trailing-frame' } },
      }, 'user-1', 'session-trailing', 'tenant-1');
      // Still buffered — no later patch has crossed the throttle boundary.
      expect(persistedArtifact().data.code).toBeUndefined();

      // The trailing-edge timer fires after the throttle window and persists it.
      vi.advanceTimersByTime(500);
      expect(persistedArtifact().data.code).toBe('trailing-frame');
      expect(persistedArtifact().status).toBe('running');
    });
  });
});
