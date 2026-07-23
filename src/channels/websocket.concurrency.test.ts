import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { loadConfig } from '../config/index.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { IncomingMessage } from './telegram.js';
import type { LLMClient } from '../core/llm.js';
import type { WebSocket } from 'ws';
import { registerWebSocketRoute } from './websocket.js';
import { createMessageHandler } from '../index.js';
import { createSession } from '../memory/sessions.js';
import { getDb } from '../store/db.js';
import type { ProgressCallback } from '../core/brain-progress.js';
import { clearRunningTurnsForTests, registerRunningTurn } from '../core/turn-cancellation.js';
import { __resetSteerStoreForTests, drainSteer } from '../gateway/steer-store.js';

const hoisted = vi.hoisted(() => ({
  handleMessage: vi.fn(),
}));

vi.mock('../security/secrets.js', () => ({
  loadEnvAndSecrets: vi.fn(),
  resolveJwtSecret: vi.fn(() => 'test-secret'),
}));

vi.mock('../system-prompt.js', () => ({
  loadSystemPrompt: vi.fn(() => 'System prompt'),
  loadDelegationSystemPrompt: vi.fn(() => 'Delegation prompt'),
  resolveWorkspaceDir: vi.fn(() => '/tmp/mozi-workspace'),
  resolveTenantId: vi.fn((tenantId?: string) => tenantId ?? 'default'),
  adaptPromptForChannel: vi.fn((prompt: string) => prompt),
}));

vi.mock('../onboarding/state.js', () => ({
  isOnboardingCompleted: vi.fn(() => true),
  getBootstrapState: vi.fn(() => 'true'),
  setBootstrapState: vi.fn(),
}));

vi.mock('../gateway/handler.js', () => ({
  handleMessage: hoisted.handleMessage,
}));

interface CapturedClient {
  socket: WebSocket;
  sent: Array<Record<string, unknown>>;
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFallbackClient(): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn(async () => ({
      content: 'unused',
      model: 'mock-model',
      stop_reason: 'end',
    })),
    async *chatStream() {
      yield {
        type: 'done' as const,
        response: {
          content: 'unused',
          model: 'mock-model',
          stop_reason: 'end' as const,
        },
      };
    },
  };
}

async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function hasMessage(client: CapturedClient, predicate: (msg: Record<string, unknown>) => boolean): boolean {
  return client.sent.some(predicate);
}

describe('channels/websocket session concurrency', () => {
  let tmpDir: string;
  let app: ReturnType<typeof Fastify>;
  let runtimeConfig: ReturnType<typeof loadConfig>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    const db = setupTestDb();
    tmpDir = db.tmpDir;
    hoisted.handleMessage.mockReset();
    clearRunningTurnsForTests();
    __resetSteerStoreForTests();
    runtimeConfig = loadConfig('/nonexistent/mozi-concurrency-test.json');
    (runtimeConfig.server as Record<string, unknown>).web_ui_turn_timeout_ms = 120_000;
    (runtimeConfig.server as Record<string, unknown>).max_concurrent_sessions_per_user = 5;

    const { handler } = createMessageHandler(makeFallbackClient(), new Date('2026-01-01T00:00:00.000Z'), runtimeConfig, () => null);
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerWebSocketRoute(app, (msg) => handler(msg as IncomingMessage), 'test-secret', { authMode: 'none' });
    await app.ready();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) {
      socket.terminate();
    }
    await app.close();
    teardownTestDb(tmpDir);
  });

  async function connectClient(): Promise<CapturedClient> {
    const socket = await app.injectWS('/ws');
    const sent: Array<Record<string, unknown>> = [];
    sockets.push(socket);
    socket.on('message', (data) => {
      sent.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    return { socket, sent };
  }

  it('/steer bypasses a busy session queue and binds to the active turn generation', async () => {
    const sessionId = createSession('local-user', 'Steer queue bypass').id;
    const firstTurn = deferred();
    let activeMessage: IncomingMessage | undefined;
    hoisted.handleMessage.mockImplementation(async (msg: IncomingMessage) => {
      activeMessage = msg;
      await firstTurn.promise;
      return 'first complete';
    });

    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: 'slow task', sessionId }));
    await waitForCondition(() => Boolean(activeMessage), 'slow turn to enter handler');
    const tenantId = activeMessage!.tenantId ?? 'default';
    const running = registerRunningTurn({
      turnId: 'turn-steer-bypass',
      tenantId,
      chatId: activeMessage!.chatId,
      userId: activeMessage!.userId,
      sessionId,
    });

    client.socket.send(JSON.stringify({ type: 'message', content: '/steer focus on cleanup', sessionId }));
    await waitForCondition(
      () => hasMessage(client, (msg) => msg.type === 'message' && String(msg.content).includes('Steer queued for the current turn')),
      'steer acknowledgement before slow turn completes',
    );
    expect(drainSteer(tenantId, activeMessage!.chatId, 'turn-steer-bypass')).toEqual(['focus on cleanup']);

    running.finish();
    firstTurn.resolve();
    await waitForCondition(
      () => hasMessage(client, (msg) => msg.type === 'message' && msg.content === 'first complete'),
      'slow turn completion',
    );
  });

  it('/steer on a new Web chat uses the first turn canonical execution scope', async () => {
    const firstTurn = deferred();
    const turnId = 'turn-steer-new-chat';
    let activeMessage: IncomingMessage | undefined;
    let resolvedSessionId = '';
    let running: ReturnType<typeof registerRunningTurn> | undefined;
    hoisted.handleMessage.mockImplementation(async (
      msg: IncomingMessage,
      _systemPrompt: string,
      _client: LLMClient,
      progress: ProgressCallback,
    ) => {
      activeMessage = msg;
      const session = createSession(msg.userId, 'New chat steer');
      resolvedSessionId = session.id;
      msg.sessionId = session.id;
      progress.onSessionResolved?.(session.id);
      running = registerRunningTurn({
        turnId,
        tenantId: msg.tenantId ?? 'default',
        chatId: msg.chatId,
        userId: msg.userId,
        sessionId: session.id,
      });
      await firstTurn.promise;
      running.finish();
      return 'first complete';
    });

    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: 'start a new slow task' }));
    await waitForCondition(
      () => Boolean(activeMessage) && hasMessage(client, msg => msg.type === 'session_bound'),
      'new chat to bind its resolved session',
    );
    expect(activeMessage!.chatId).not.toBe(`local-user:${resolvedSessionId}`);

    // The connection is now session-bound, so this command arrives through the
    // user:sessionId alias while the Brain still executes under user:connectionId.
    client.socket.send(JSON.stringify({ type: 'message', content: '/steer focus the first turn' }));
    await waitForCondition(
      () => hasMessage(client, msg => msg.type === 'message' && String(msg.content).includes('Steer queued for the current turn')),
      'first-turn steer acknowledgement',
    );

    const tenantId = activeMessage!.tenantId ?? 'default';
    expect(drainSteer(tenantId, activeMessage!.chatId, turnId)).toEqual(['focus the first turn']);

    firstTurn.resolve();
    await waitForCondition(
      () => hasMessage(client, msg => msg.type === 'message' && msg.content === 'first complete'),
      'first new-chat turn completion',
    );
  });

  it('/steer rejects immediately when the chat has no active turn', async () => {
    const sessionId = createSession('local-user', 'Inactive steer').id;
    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: '/steer orphan input', sessionId }));
    await waitForCondition(
      () => hasMessage(client, (msg) => msg.type === 'message' && String(msg.content).includes('no active turn')),
      'inactive steer rejection',
    );
    expect(hoisted.handleMessage).not.toHaveBeenCalled();
  });

  it('runs same-user messages from different sessions in parallel', async () => {
    const sessionAId = createSession('local-user', 'Parallel A').id;
    const sessionBId = createSession('local-user', 'Parallel B').id;
    const sessionA = deferred();
    const sessionB = deferred();
    const started: string[] = [];
    let running = 0;
    let maxRunning = 0;

    hoisted.handleMessage.mockImplementation(async (msg: IncomingMessage) => {
      started.push(msg.sessionId ?? '');
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      try {
        await (msg.sessionId === sessionAId ? sessionA.promise : sessionB.promise);
        return `reply:${msg.sessionId}`;
      } finally {
        running -= 1;
      }
    });

    const clientA = await connectClient();
    const clientB = await connectClient();
    clientA.socket.send(JSON.stringify({ type: 'message', content: 'first', sessionId: sessionAId }));
    clientB.socket.send(JSON.stringify({ type: 'message', content: 'second', sessionId: sessionBId }));

    await waitForCondition(() => started.length === 2, 'both sessions to start');
    expect(started).toEqual(expect.arrayContaining([sessionAId, sessionBId]));
    expect(maxRunning).toBe(2);
    expect(hasMessage(clientA, msg => msg.type === 'turn_queue')).toBe(false);
    expect(hasMessage(clientB, msg => msg.type === 'turn_queue')).toBe(false);

    sessionA.resolve();
    sessionB.resolve();
    await waitForCondition(
      () => hasMessage(clientA, msg => msg.type === 'message' && msg.content === `reply:${sessionAId}`)
        && hasMessage(clientB, msg => msg.type === 'message' && msg.content === `reply:${sessionBId}`),
      'parallel replies',
    );
  });

  it('persists and broadcasts the synchronous reply with the handler-stamped turnId + seq even after the turn is unregistered (Issue #627)', async () => {
    const sessionId = createSession('local-user', 'Sync reply identity').id;
    const STAMPED_TURN = 'turn_sync_reply_627';

    // The real handler surfaces server-authoritative turn identity on the shared
    // message object and then returns — by which point the active-turn registry
    // no longer holds the turn. We deliberately do NOT register a running turn:
    // an empty registry at persist time is the exact defect condition the fix
    // must survive (previously the row/frame lost turnId + seq here).
    hoisted.handleMessage.mockImplementation(async (msg: IncomingMessage) => {
      msg.turnId = STAMPED_TURN;
      return 'final answer';
    });

    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: 'hello', sessionId }));

    await waitForCondition(
      () => hasMessage(client, msg => msg.type === 'message' && msg.role === 'assistant'),
      'assistant reply frame',
    );

    const reply = client.sent.find(msg => msg.type === 'message' && msg.role === 'assistant')!;
    expect(reply.content).toBe('final answer');
    expect(reply.turnId).toBe(STAMPED_TURN);
    expect(typeof reply.seq).toBe('number');
    expect(reply.seq as number).toBeGreaterThan(0);

    // The persisted timeline row carries the same identity + sequence.
    const row = getDb().prepare(`
      SELECT turn_id, turn_seq FROM session_timeline_events
      WHERE tenant_id = 'default' AND session_id = ? AND item_type = 'message'
        AND json_extract(payload, '$.role') = 'assistant'
      ORDER BY id DESC LIMIT 1
    `).get(sessionId) as { turn_id: string | null; turn_seq: number | null } | undefined;
    expect(row?.turn_id).toBe(STAMPED_TURN);
    expect(row?.turn_seq).toBe(reply.seq);
  });

  it('binds a newly resolved session to only the originating socket before its first stream frame', async () => {
    let resolvedSessionId = '';
    const receivedSessionIds: Array<string | undefined> = [];
    hoisted.handleMessage.mockImplementation(async (
      msg: IncomingMessage,
      _systemPrompt: string,
      _client: LLMClient,
      progress: ProgressCallback,
    ) => {
      receivedSessionIds.push(msg.sessionId);
      const created = createSession(msg.userId, 'Bound draft');
      const sessionId = msg.sessionId ?? created.id;
      resolvedSessionId ||= sessionId;
      msg.sessionId = sessionId;
      if (!receivedSessionIds.at(-1)) progress.onSessionResolved?.(sessionId);
      progress.onProcessingStart?.();
      progress.onStreamEnd?.('bound answer');
      return null;
    });

    const origin = await connectClient();
    const other = await connectClient();
    origin.socket.send(JSON.stringify({ type: 'message', content: 'new draft' }));

    await waitForCondition(
      () => hasMessage(origin, msg => msg.type === 'stream_end'),
      'bound stream completion',
    );

    const boundIndex = origin.sent.findIndex(msg => msg.type === 'session_bound');
    const streamIndex = origin.sent.findIndex(msg => msg.type === 'stream_start');
    expect(boundIndex).toBeGreaterThanOrEqual(0);
    expect(streamIndex).toBeGreaterThan(boundIndex);
    expect(origin.sent[boundIndex]).toMatchObject({
      type: 'session_bound',
      sessionId: resolvedSessionId,
    });
    expect(other.sent.some(msg => msg.type === 'session_bound')).toBe(false);
    // Existing fan-out may deliver owner-scoped stream frames to another tab,
    // but they remain session-scoped and that tab is never switched to accept
    // them. Only the originating socket receives the binding authority.
    for (const msg of other.sent.filter(msg => msg.type === 'stream_start' || msg.type === 'stream_end')) {
      expect(msg.sessionId).toBe(resolvedSessionId);
    }

    // The UI may rely on the connection binding rather than duplicating the
    // session id in every later message. The transport must carry that bound
    // identity into the next handler call or multi-turn history is lost.
    origin.socket.send(JSON.stringify({ type: 'message', content: 'second turn' }));
    await waitForCondition(() => receivedSessionIds.length === 2, 'bound second turn');
    expect(receivedSessionIds).toEqual([undefined, resolvedSessionId]);
  });

  it('serializes back-to-back messages in the same session and emits a real queued status', async () => {
    const sessionId = createSession('local-user', 'Serial').id;
    const first = deferred();
    const second = deferred();
    const started: string[] = [];
    const finished: string[] = [];

    hoisted.handleMessage.mockImplementation(async (msg: IncomingMessage) => {
      started.push(msg.text);
      await (msg.text === 'first' ? first.promise : second.promise);
      finished.push(msg.text);
      return `reply:${msg.text}`;
    });

    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: 'first', sessionId }));
    client.socket.send(JSON.stringify({ type: 'message', content: 'second', sessionId }));

    await waitForCondition(() => started.length === 1, 'first message to start');
    await waitForCondition(
      () => hasMessage(client, msg => (
        msg.type === 'turn_queue'
        && msg.status === 'queued'
        && msg.queueDepth === 1
        && msg.reason === 'session_busy'
        && msg.sessionId === sessionId
      )),
      'queued status for same-session second message',
    );
    expect(started).toEqual(['first']);
    expect(finished).toEqual([]);

    first.resolve();
    await waitForCondition(() => started.length === 2, 'second message to start after first resolves');
    expect(finished).toEqual(['first']);
    expect(started).toEqual(['first', 'second']);

    second.resolve();
    await waitForCondition(
      () => hasMessage(client, msg => msg.type === 'message' && msg.content === 'reply:second'),
      'second reply',
    );
  });

  it('aborts a stalled WebSocket turn (no progress within the idle window) and notifies the client', async () => {
    const sessionId = createSession('local-user', 'Timeout').id;
    const config = loadConfig('/nonexistent/mozi-concurrency-timeout-test.json');
    (config.server as Record<string, unknown>).web_ui_turn_timeout_ms = 30;
    (config.server as Record<string, unknown>).max_concurrent_sessions_per_user = 5;
    const { handler } = createMessageHandler(makeFallbackClient(), new Date('2026-01-01T00:00:00.000Z'), config, () => null);
    await app.close();
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerWebSocketRoute(app, (msg) => handler(msg as IncomingMessage), 'test-secret', { authMode: 'none' });
    await app.ready();

    let observedAbort = false;
    hoisted.handleMessage.mockImplementation(async (
      _msg: IncomingMessage,
      _systemPrompt: string,
      _client: LLMClient,
      _progress: unknown,
      _outputChannel: unknown,
      externalAbortSignal?: AbortSignal,
    ) => {
      await new Promise<void>((resolve) => {
        if (externalAbortSignal?.aborted) {
          observedAbort = true;
          resolve();
          return;
        }
        externalAbortSignal?.addEventListener('abort', () => {
          observedAbort = true;
          resolve();
        }, { once: true });
      });
      return '';
    });

    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: 'slow', sessionId }));

    await waitForCondition(() => observedAbort, 'timeout abort signal');
    await waitForCondition(
      () => hasMessage(client, msg => (
        msg.type === 'error'
        && typeof msg.message === 'string'
        && msg.message.includes('no progress')
        && msg.sessionId === sessionId
      )),
      'timeout notification',
    );
  });

  it('keeps a progressing WebSocket turn alive past the idle window (idle timeout, not wall-clock)', async () => {
    const sessionId = createSession('local-user', 'Progressing').id;
    const config = loadConfig('/nonexistent/mozi-concurrency-idle-test.json');
    // 40ms idle window; the handler below emits progress every 15ms for ~150ms,
    // i.e. well past the window. Under a wall-clock cap this would be killed;
    // under the idle timeout each progress signal re-arms it, so it survives.
    (config.server as Record<string, unknown>).web_ui_turn_timeout_ms = 40;
    (config.server as Record<string, unknown>).max_concurrent_sessions_per_user = 5;
    const { handler } = createMessageHandler(makeFallbackClient(), new Date('2026-01-01T00:00:00.000Z'), config, () => null);
    await app.close();
    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    registerWebSocketRoute(app, (msg) => handler(msg as IncomingMessage), 'test-secret', { authMode: 'none' });
    await app.ready();

    let aborted = false;
    let handlerCompleted = false;
    hoisted.handleMessage.mockImplementation(async (
      _msg: IncomingMessage,
      _systemPrompt: string,
      _client: LLMClient,
      progress: { onStreamChunk?: (text: string) => void; onStreamEnd?: (text: string) => void } | undefined,
      _outputChannel: unknown,
      externalAbortSignal?: AbortSignal,
    ) => {
      externalAbortSignal?.addEventListener('abort', () => { aborted = true; }, { once: true });
      for (let i = 0; i < 10 && !externalAbortSignal?.aborted; i++) {
        progress?.onStreamChunk?.(`working ${i}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      progress?.onStreamEnd?.('done working');
      handlerCompleted = true;
      return 'done working';
    });

    const client = await connectClient();
    client.socket.send(JSON.stringify({ type: 'message', content: 'busy', sessionId }));

    await waitForCondition(() => handlerCompleted, 'progressing turn to finish');
    // The core guarantee: an actively-progressing turn is never aborted, and no
    // stalled-turn error is sent to the client.
    expect(aborted).toBe(false);
    expect(hasMessage(client, msg => (
      msg.type === 'error' && typeof msg.message === 'string' && msg.message.includes('no progress')
    ))).toBe(false);
  });

  it('queues a different session when the user concurrency cap is full', async () => {
    const sessionAId = createSession('local-user', 'Cap A').id;
    const sessionBId = createSession('local-user', 'Cap B').id;
    (runtimeConfig.server as Record<string, unknown>).max_concurrent_sessions_per_user = 1;
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    hoisted.handleMessage.mockImplementation(async (msg: IncomingMessage) => {
      started.push(msg.sessionId ?? '');
      await (msg.sessionId === sessionAId ? first.promise : second.promise);
      return `reply:${msg.sessionId}`;
    });

    const clientA = await connectClient();
    const clientB = await connectClient();
    clientA.socket.send(JSON.stringify({ type: 'message', content: 'first', sessionId: sessionAId }));
    await waitForCondition(() => started.length === 1, 'first capped session to start');

    clientB.socket.send(JSON.stringify({ type: 'message', content: 'second', sessionId: sessionBId }));
    await waitForCondition(
      () => hasMessage(clientB, msg => (
        msg.type === 'turn_queue'
        && msg.status === 'queued'
        && msg.queueDepth === 1
        && msg.reason === 'user_concurrency_limit'
        && msg.sessionId === sessionBId
      )),
      'per-user cap queued status',
    );
    expect(started).toEqual([sessionAId]);

    first.resolve();
    await waitForCondition(() => started.length === 2, 'second capped session to start');
    expect(started).toEqual([sessionAId, sessionBId]);

    second.resolve();
    await waitForCondition(
      () => hasMessage(clientB, msg => msg.type === 'message' && msg.content === `reply:${sessionBId}`),
      'capped second reply',
    );
  });
});
