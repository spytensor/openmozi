import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import {
  __clearInMemoryGatewayStateForTests,
  __getInMemorySessionForTests,
  handleMessage,
  type ProgressCallback,
} from './handler.js';
import { getDb } from '../store/db.js';
import { getHistory, saveMessage } from '../memory/conversations.js';
import { getSessionTimeline, getSessionTimelinePage } from '../memory/session-timeline.js';
import { createSession, listSessions } from '../memory/sessions.js';
import { searchDigests } from '../memory/session-digest.js';
import { saveProfileField } from '../memory/user-profile.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import type { IncomingMessage } from '../channels/telegram.js';
import type { LLMClient, ChatMessage, ChatOptions, ChatResponse, StreamChunk } from '../core/llm.js';
import { clearRunningTurnsForTests, getActiveTurnForChat } from '../core/turn-cancellation.js';
import { getTurnEnvelope, getSessionTurns } from '../memory/turn-envelopes.js';
import { broadcastStreamEvent } from '../channels/websocket.js';
import { MoziConfigSchema } from '../config/index.js';
import { loadDelegationSystemPrompt } from '../system-prompt.js';
import { createPlanTasks } from '../core/plan-runner.js';
import { updateStatus } from '../store/task-dag.js';

// Mock model-router so handleMessage always uses our fallback client
vi.mock('../core/model-router.js', () => ({
  getBrainClient: () => { throw new Error('No brain client in test'); },
  getClientForTask: () => { throw new Error('No lightweight client in test'); },
  selectModel: () => ({ model: 'mock', provider: 'mock', role: 'general' }),
  getClient: () => { throw new Error('No client'); },
}));

vi.mock('../capabilities/vision.js', () => ({
  analyzeImage: vi.fn().mockResolvedValue('A mountain with snow.'),
}));

let tmpDir: string;

beforeAll(() => {
  const result = setupTestDb();
  tmpDir = result.tmpDir;
  // Complete profile so first-contact guide is not injected into system prompts
  saveProfileField('user_display_name', 'TestUser');
  saveProfileField('bot_nickname', 'MOZI');
  saveProfileField('communication_style', 'concise');
  saveProfileField('language_preference', 'en');
  saveProfileField('primary_use_case', 'testing');
  saveProfileField('primary_domain', 'engineering');
});

afterAll(() => {
  teardownTestDb(tmpDir);
});

beforeEach(() => {
  __clearInMemoryGatewayStateForTests();
  clearRunningTurnsForTests();
});

function makeMsg(text: string, chatId = 'test_chat'): IncomingMessage {
  return {
    channelType: 'telegram',
    chatId,
    tenantId: 'default',
    userId: 'user_1',
    username: 'testuser',
    text,
    isCommand: false,
    timestamp: new Date(),
  };
}

function makeMockClient(reply = 'Mock reply'): LLMClient {
  return {
    provider: 'mock',
    chat: vi.fn().mockResolvedValue({
      content: reply,
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse),
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: reply };
      yield { type: 'done', response: { content: reply, usage: { input_tokens: 10, output_tokens: 20 }, model: 'mock-model', stop_reason: 'end' } };
    },
  };
}

function makeDigestAwareMockClient(reply: string, digest: string): LLMClient {
  const chat = vi.fn(async (messages: ChatMessage[]) => {
    const system = messages[0]?.content ?? '';
    let content = reply;
    if (system.includes('Summarize this conversation session')) {
      content = JSON.stringify({
        digest,
        topics: ['typescript', 'migration'],
        open_threads: ['Confirm the rollout owner'],
      });
    } else if (system.includes('Given this conversation turn')) {
      content = '{"preferences":[],"facts":[],"decisions":[],"corrections":[]}';
    } else if (system.includes('Extract project-level knowledge')) {
      content = '{"items":[]}';
    } else if (system.includes('Generate a concise title')) {
      content = 'Fresh Session';
    }

    return {
      content,
      usage: { input_tokens: 10, output_tokens: 20 },
      model: 'mock-model',
      stop_reason: 'end',
    } satisfies ChatResponse;
  });

  return {
    provider: 'mock',
    chat,
    async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncGenerator<StreamChunk> {
      yield {
        type: 'done',
        response: {
          content: reply,
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'mock-model',
          stop_reason: 'end',
        },
      };
    },
  };
}

async function waitForDigestRow(sessionId: string, tenantId = 'default'): Promise<{ digest: string }> {
  const db = getDb();
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const row = db.prepare(`
      SELECT digest
      FROM session_digests
      WHERE tenant_id = ? AND session_id = ?
    `).get(tenantId, sessionId) as { digest: string } | undefined;
    if (row) return row;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for digest row for ${sessionId}`);
}

describe('gateway/handler', () => {
  it('returns LLM response for simple message', async () => {
    const client = makeMockClient('Hello from LLM');
    const result = await handleMessage(makeMsg('hi', 'simple_test'), 'You are helpful.', client);
    expect(result).toBe('Hello from LLM');
  });

  it('passes the real SOUL identity to DAG step system roles on a real gateway turn', async () => {
    const previousInlineMode = process.env.MOZI_TEST_INLINE_DAG;
    process.env.MOZI_TEST_INLINE_DAG = '1';
    const delegationPrompt = loadDelegationSystemPrompt(MoziConfigSchema.parse({
      workspace: { dir: tmpDir },
    }));
    const capturedStepSystems: string[] = [];
    let requestedPlan = false;

    const respond = async (messages: ChatMessage[]): Promise<ChatResponse> => {
      const lastUser = [...messages].reverse().find((message) => message.role === 'user');
      const userText = String(lastUser?.content ?? '');
      if (userText.includes('Task: Gather facts') || userText.includes('Task: Summarize facts')) {
        capturedStepSystems.push(String(messages.find((message) => message.role === 'system')?.content ?? ''));
        return {
          content: `completed ${userText.split('\n')[0]}`,
          usage: { input_tokens: 10, output_tokens: 10 },
          model: 'mock-model',
          stop_reason: 'end',
        };
      }
      if (!requestedPlan) {
        requestedPlan = true;
        return {
          content: '',
          tool_calls: [{
            id: 'tc_real_dag_prompt',
            type: 'function',
            function: {
              name: 'decompose_task',
              arguments: JSON.stringify({
                goal: 'Research and summarize two facts',
                subtasks: [
                  { title: 'Gather facts', objective: 'Gather two facts', done_criteria: 'facts captured', depends_on: [] },
                  { title: 'Summarize facts', objective: 'Summarize the facts', done_criteria: 'summary written', depends_on: [0] },
                ],
              }),
            },
          }],
          usage: { input_tokens: 10, output_tokens: 10 },
          model: 'mock-model',
          stop_reason: 'tool-calls',
        };
      }
      return {
        content: 'Plan completed.',
        usage: { input_tokens: 10, output_tokens: 10 },
        model: 'mock-model',
        stop_reason: 'end',
      };
    };

    const client: LLMClient = {
      provider: 'mock',
      chat: vi.fn(respond),
      async *chatStream(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
        const response = await respond(messages);
        yield { type: 'done', response };
      },
    };

    try {
      await handleMessage(
        makeMsg('Research two facts with a two-step plan', 'real_dag_prompt_turn'),
        'Brain-only turn prompt with channel and memory context.',
        client,
        undefined,
        undefined,
        undefined,
        delegationPrompt,
      );
    } finally {
      if (previousInlineMode === undefined) delete process.env.MOZI_TEST_INLINE_DAG;
      else process.env.MOZI_TEST_INLINE_DAG = previousInlineMode;
    }

    expect(capturedStepSystems).toHaveLength(2);
    for (const system of capturedStepSystems) {
      expect(system).toContain('# SOUL.md — Runtime Identity');
      expect(system).toContain('Use only these currently exposed tools.');
      expect(system).not.toContain('Runtime Capability Contract');
      expect(system).not.toContain('Brain-only turn prompt');
    }
  });

  it('rejects unsupported sandbox references before an interactive reply becomes durable', async () => {
    const chatId = 'interactive_sandbox_pointer_test';
    const rawReply = 'Use [latest report](sandbox:/reports/latest), sandbox:/chart.png, sandbox:/notes.md, and sandbox:/result.txt.';
    const client = makeMockClient(rawReply);
    client.chatStream = async function* (): AsyncGenerator<StreamChunk> {
      // Split exactly after the scheme to prove even an incomplete streamed URI
      // is rejected before its first broadcast/persistence boundary.
      yield { type: 'text', text: 'Use [latest report](sandbox:' };
      yield { type: 'text', text: '/reports/latest), sandbox:/chart.png, sandbox:/notes.md, and sandbox:/result.txt.' };
      yield {
        type: 'done',
        response: {
          content: rawReply,
          usage: { input_tokens: 10, output_tokens: 20 },
          model: 'mock-model',
          stop_reason: 'end',
        },
      };
    };
    const streamedChunks: string[] = [];
    const streamedEnds: string[] = [];
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onStreamChunk: (text) => streamedChunks.push(text),
      onStreamEnd: (text) => streamedEnds.push(text),
    };

    const result = await handleMessage(makeMsg('show the files', chatId), 'You are helpful.', client, progress);
    expect(result).toContain('latest report');
    expect(result).toContain('Runtime note');
    expect(result).not.toContain('sandbox:');
    expect(streamedChunks.length).toBeGreaterThan(0);
    expect(streamedEnds.length).toBeGreaterThan(0);
    expect(streamedChunks.every(text => !text.includes('sandbox:'))).toBe(true);
    expect(streamedEnds.every(text => !text.includes('sandbox:'))).toBe(true);

    const assistant = getHistory(chatId).find(message => message.role === 'assistant');
    expect(assistant?.content).toBe(result);
    expect(assistant?.content).not.toContain('sandbox:');
  });

  it('stamps the server-authoritative turnId onto the incoming message so the sync reply can persist with it (Issue #627)', async () => {
    const session = createSession('user_1', 'Turn identity session');
    const client = makeMockClient('Reply body');
    const msg: IncomingMessage = {
      ...makeMsg('hello', 'user_1'),
      channelType: 'websocket',
      sessionId: session.id,
    };
    // The caller must NOT pre-set turnId; handleMessage owns it.
    expect(msg.turnId).toBeUndefined();

    const result = await handleMessage(msg, 'You are helpful.', client);
    expect(result).toBe('Reply body');

    // Fix for the sync-reply defect: the real turn id is surfaced back on the
    // shared message object (the registry is already cleared by return time).
    expect(typeof msg.turnId).toBe('string');
    expect((msg.turnId as string).length).toBeGreaterThan(0);
    // And it is the id that actually owns the persisted, now-completed turn.
    const env = getTurnEnvelope(session.id, msg.turnId as string, 'default');
    expect(env).not.toBeNull();
    expect(env?.status).toBe('completed');
    // The turn is unregistered once handleMessage returns — which is exactly why
    // a registry lookup in the sync-reply path would have missed.
    expect(getActiveTurnForChat('user_1', 'default')).toBeNull();
  });

  it('persists streamed assistant output on a brand-new Web chat with no incoming sessionId, sharing the user turn (Issue #627)', async () => {
    // Reproduce the Docker UI acceptance failure: the first message of a new Web
    // chat carries no sessionId, and the WebSocket chatId is the client-scoped
    // `userId:clientId` form (logs showed `local-user:ws-client`). handleMessage
    // owns/creates the session; the streaming progress callbacks must persist the
    // assistant output under that session with the real turn id.
    const userId = 'ws-new-chat-user';
    const chatId = `${userId}:ws-client-abc`; // buildWebSocketChatId(client, undefined)
    const client = makeMockClient('Streamed assistant answer');

    const msg: IncomingMessage = {
      ...makeMsg('first message in a brand new chat', chatId),
      userId,
      channelType: 'websocket',
    };
    // First new chat: the client sent no sessionId.
    expect(msg.sessionId).toBeUndefined();

    // Faithful replica of the src/index.ts WebSocket progress wiring. Each callback
    // reads msg.sessionId at call-time and forwards it to broadcastStreamEvent —
    // exactly the seam where the undefined-sessionId persistence gap manifested.
    const requestId = 'req-newchat-0';
    let started = false;
    const emitStart = () => {
      if (started) return;
      started = true;
      broadcastStreamEvent('stream_start', requestId, undefined, msg.userId, msg.sessionId, msg.tenantId);
    };
    const progress: ProgressCallback = {
      onProcessingStart: emitStart,
      onStreamChunk: (accumulated: string) => {
        if (!accumulated.trim()) return;
        emitStart();
        broadcastStreamEvent('stream_chunk', requestId, accumulated, msg.userId, msg.sessionId, msg.tenantId);
      },
      onStreamEnd: (fullText: string) => {
        if (!fullText.trim()) return;
        emitStart();
        broadcastStreamEvent('stream_end', requestId, fullText, msg.userId, msg.sessionId, msg.tenantId);
      },
    };

    await handleMessage(msg, 'You are helpful.', client, progress);

    // The created session id is surfaced back onto the shared message so the
    // stream/artifact/final paths all target the real session.
    expect(typeof msg.sessionId).toBe('string');
    const sessionId = msg.sessionId as string;

    // Reload path: the endpoint composes getSessionTimelinePage + getSessionTurns.
    const page = getSessionTimelinePage(sessionId, { tenantId: 'default', limit: 100 });
    const messages = page.timeline.filter((i) => i.type === 'message');
    const userRow = messages.find((i) => (i.data as { role?: string }).role === 'user');
    const assistantRow = messages.find((i) => (i.data as { role?: string }).role === 'assistant');

    expect(userRow, 'user message row must be persisted').toBeDefined();
    // Before the fix the streamed assistant row was dropped (undefined sessionId).
    expect(assistantRow, 'streamed assistant row must be persisted under the session').toBeDefined();
    expect((assistantRow!.data as { content?: string }).content).toBe('Streamed assistant answer');

    // Both rows share the real, non-empty turn id.
    expect(typeof userRow!.turnId).toBe('string');
    expect((userRow!.turnId as string).length).toBeGreaterThan(0);
    expect(assistantRow!.turnId).toBe(userRow!.turnId);

    // Per-turn sequence is monotonic 1..N with no gaps.
    const seqs = messages
      .map((i) => i.seq)
      .filter((s): s is number => typeof s === 'number')
      .sort((a, b) => a - b);
    expect(seqs.length).toBe(messages.length);
    expect(seqs).toEqual(seqs.map((_, idx) => idx + 1));

    // The turn envelope high-water matches the max assigned sequence.
    const env = getSessionTurns(sessionId, 'default').find((t) => t.turnId === userRow!.turnId);
    expect(env).toBeDefined();
    expect(env!.seqHighWater).toBe(seqs[seqs.length - 1]);

    // Issue #628: the authoritative presentation locale is stamped on the
    // envelope by the live handleMessage path (not guessed later in the UI). The
    // English prompt above yields 'en'; this proves the producer wiring end-to-end.
    expect(env!.locale).toBe('en');
  });

  it('rejects a session owned by another user before executing the turn', async () => {
    const otherSession = createSession('other-user', 'Private session');
    const client = makeMockClient('must not run');

    await expect(handleMessage(
      {
        ...makeMsg('write into another session', 'attacker-chat'),
        channelType: 'websocket',
        userId: 'attacker-user',
        sessionId: otherSession.id,
      },
      'system prompt',
      client,
    )).rejects.toThrow('Session not found or access denied.');
  });

  it('saves user and assistant messages to DB', async () => {
    const chatId = 'persist_test';
    const client = makeMockClient('Persisted reply');
    await handleMessage(makeMsg('test message', chatId), 'system prompt', client);

    const history = getHistory(chatId);
    expect(history.length).toBeGreaterThanOrEqual(2);

    const userMsg = history.find(m => m.role === 'user' && m.content === 'test message');
    expect(userMsg).toBeDefined();

    const assistantMsg = history.find(m => m.role === 'assistant' && m.content === 'Persisted reply');
    expect(assistantMsg).toBeDefined();
  });

  it('persists the incoming user message into the restorable session timeline', async () => {
    const userId = 'timeline_user_1';
    const chatId = 'timeline_user_message_test';
    const client = makeMockClient('Timeline reply');

    await handleMessage(
      { ...makeMsg('restore this visible user message', chatId), userId, channelType: 'websocket' },
      'system prompt',
      client,
    );

    const session = listSessions(userId)[0];
    expect(session).toBeDefined();

    const timeline = getSessionTimeline(session.id, 20, 'default');
    const userMessage = timeline.find((item) => item.type === 'message' && (item.data as { role?: string }).role === 'user');
    expect(userMessage).toMatchObject({
      type: 'message',
      data: {
        role: 'user',
        content: 'restore this visible user message',
      },
    });
  });

  it('preserves the original turn and clones the prompt into a distinct regenerate turn', async () => {
    const userId = 'timeline_regenerate_user_1';
    const chatId = 'timeline_regenerate_test';
    const client = makeMockClient('Regenerated reply');

    await handleMessage(
      { ...makeMsg('retry this visible user message', chatId), userId, channelType: 'websocket' },
      'system prompt',
      client,
    );

    const session = listSessions(userId)[0];
    expect(session).toBeDefined();

    await handleMessage(
      {
        ...makeMsg('retry this visible user message', chatId),
        userId,
        channelType: 'websocket',
        sessionId: session.id,
        suppressUserMessagePersistence: true,
      },
      'system prompt',
      client,
    );

    const historyUserMessages = getHistory(chatId).filter(
      (message) => message.role === 'user' && message.content === 'retry this visible user message',
    );
    expect(historyUserMessages).toHaveLength(1);

    const timelineUserMessages = getSessionTimeline(session.id, 20, 'default').filter(
      (item) => item.type === 'message' && (item.data as { role?: string; content?: string }).role === 'user',
    );
    expect(timelineUserMessages).toHaveLength(2);
    expect(timelineUserMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({ data: expect.objectContaining({
        role: 'user',
        content: 'retry this visible user message',
      }) }),
    ]));
  });

  it('starts progress only after the user message is durable in the session timeline', async () => {
    const userId = 'timeline_order_user_1';
    const chatId = 'timeline_progress_order_test';
    const client = makeMockClient('Order reply');
    let userMessageWasDurable = false;
    const progress: ProgressCallback = {
      onProcessingStart: () => {
        const session = listSessions(userId)[0];
        const timeline = session ? getSessionTimeline(session.id, 20, 'default') : [];
        userMessageWasDurable = timeline.some((item) => (
          item.type === 'message' &&
          (item.data as { role?: string; content?: string }).role === 'user' &&
          (item.data as { role?: string; content?: string }).content === 'progress follows durable user message'
        ));
      },
      onToolStart: () => {},
      onToolEnd: () => {},
    };

    await handleMessage(
      { ...makeMsg('progress follows durable user message', chatId), userId, channelType: 'websocket' },
      'system prompt',
      client,
      progress,
    );

    expect(userMessageWasDurable).toBe(true);
  });

  it('persists non-default tenant messages under the session tenant', async () => {
    const tenantId = 'tenant_handler_scope';
    const chatId = 'tenant_scope_test';
    const userId = 'tenant_user_1';
    saveProfileField('user_display_name', 'Tenant User', tenantId);
    saveProfileField('bot_nickname', 'MOZI', tenantId);
    saveProfileField('communication_style', 'concise', tenantId);
    saveProfileField('language_preference', 'en', tenantId);
    saveProfileField('primary_use_case', 'testing', tenantId);
    saveProfileField('primary_domain', 'engineering', tenantId);

    const client = makeMockClient('Tenant scoped reply');
    await handleMessage(
      { ...makeMsg('tenant scoped message', chatId), tenantId, userId },
      'system prompt',
      client,
    );

    expect(getHistory(chatId, 20, 'default')).toHaveLength(0);
    const tenantHistory = getHistory(chatId, 20, tenantId);
    expect(tenantHistory.find(m => m.role === 'user' && m.content === 'tenant scoped message')).toBeDefined();
    expect(tenantHistory.find(m => m.role === 'assistant' && m.content === 'Tenant scoped reply')).toBeDefined();

    const tenantSessions = listSessions(userId, { tenantId });
    expect(tenantSessions).toHaveLength(1);
    expect(tenantSessions[0].message_count).toBe(2);
  });

  it('writes and searches a session digest when a stale session rolls over', async () => {
    const userId = 'digest_rollover_user';
    const chatId = 'digest_rollover_chat';
    const oldSession = createSession(userId, 'Old digestible session');
    saveMessage(chatId, 'user', 'We planned the TypeScript migration from CommonJS to ESM.', undefined, undefined, oldSession.id);
    saveMessage(chatId, 'assistant', 'We decided to update tsconfig and package exports first.', 'mock-model', 0, oldSession.id);
    saveMessage(chatId, 'user', 'Remember the rollout risk around background jobs.', undefined, undefined, oldSession.id);
    saveMessage(chatId, 'assistant', 'Open thread: confirm the rollout owner before shipping.', 'mock-model', 0, oldSession.id);
    getDb().prepare(`UPDATE sessions SET updated_at = datetime('now', '-25 hours') WHERE id = ?`).run(oldSession.id);

    const digest = 'The session planned a TypeScript migration and identified background job rollout risk. The open thread is to confirm the rollout owner before shipping.';
    const client = makeDigestAwareMockClient('Fresh rollover reply', digest);

    await handleMessage(
      { ...makeMsg('Start a fresh session after the old planning work', chatId), userId },
      'system prompt',
      client,
    );

    const row = await waitForDigestRow(oldSession.id);
    expect(row.digest).toBe(digest);

    const count = getDb().prepare(`
      SELECT COUNT(*) AS count
      FROM session_digests
      WHERE tenant_id = 'default' AND session_id = ?
    `).get(oldSession.id) as { count: number };
    expect(count.count).toBe(1);

    const results = searchDigests(userId, 'TypeScript migration rollout owner', 'default', 5);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: oldSession.id,
          digest,
        }),
      ]),
    );
  });

  it('handles LLM errors by throwing', async () => {
    const client: LLMClient = {
      provider: 'mock',
      chat: vi.fn().mockRejectedValue(new Error('LLM down')),
      async *chatStream(): AsyncGenerator<StreamChunk> {
        throw new Error('LLM down');
      },
    };

    await expect(
      handleMessage(makeMsg('hello', 'error_test'), 'sys', client)
    ).rejects.toThrow('LLM down');
  });

  it('works with different chat IDs independently', async () => {
    const clientA = makeMockClient('Reply A');
    const clientB = makeMockClient('Reply B');

    await handleMessage(makeMsg('msg A', 'chat_A_handler'), 'sys', clientA);
    await handleMessage(makeMsg('msg B', 'chat_B_handler'), 'sys', clientB);

    const histA = getHistory('chat_A_handler');
    const histB = getHistory('chat_B_handler');

    expect(histA.find(m => m.content === 'msg A')).toBeDefined();
    expect(histB.find(m => m.content === 'msg B')).toBeDefined();
    expect(histA.find(m => m.content === 'msg B')).toBeUndefined();
  });

  it('stores model and token info for assistant messages', async () => {
    const chatId = 'token_test';
    const client = makeMockClient('Token reply');
    await handleMessage(makeMsg('hi', chatId), 'sys', client);

    const history = getHistory(chatId);
    const assistantMsg = history.find(m => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.model).toBe('mock-model');
    expect(assistantMsg!.tokens_used).toBe(30); // 10 input + 20 output
  });

  it('stores cumulative token usage from tool-loop LLM calls', async () => {
    const chatId = 'token_tool_loop_test';
    const responses: ChatResponse[] = [
      {
        content: '',
        tool_calls: [{
          id: 'tc_token_loop',
          type: 'function',
          function: { name: 'unknown_tool', arguments: '{"step":1}' },
        }],
        usage: { input_tokens: 11, output_tokens: 13 },
        model: 'mock-model',
        stop_reason: 'tool-calls',
      },
      {
        content: 'Tool loop final reply',
        usage: { input_tokens: 17, output_tokens: 19 },
        model: 'mock-model',
        stop_reason: 'end',
      },
      {
        content: 'background ok',
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'mock-model',
        stop_reason: 'end',
      },
    ];
    let callIndex = 0;
    const client: LLMClient = {
      provider: 'mock',
      chat: vi.fn(async () => {
        const response = responses[Math.min(callIndex, responses.length - 1)];
        callIndex += 1;
        return response;
      }),
      async *chatStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done', response: responses[1] };
      },
    };

    await handleMessage(makeMsg('hi', chatId), 'sys', client);

    const assistantMsg = getHistory(chatId).find(m => m.role === 'assistant');
    expect(assistantMsg?.content).toBe('Tool loop final reply');
    expect(assistantMsg?.tokens_used).toBe(60);
  });

  it('appends text attachment content as a code block in the LLM user message', async () => {
    const chatId = 'attachment_test';
    const client = makeMockClient('attachment ok');
    const incoming: IncomingMessage = {
      ...makeMsg('Review this file', chatId),
      attachments: [
        {
          type: 'document',
          path: 'workspace/tmp/example.ts',
          mime: 'text/typescript',
          filename: 'example.ts',
          content: 'export const answer = 42;',
        },
      ],
    };

    await handleMessage(incoming, 'sys', client);

    const chatCall = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = chatCall[0] as ChatMessage[];
    const userMessage = messages[messages.length - 1];
    expect(userMessage.role).toBe('user');
    expect(userMessage.content).toContain('Review this file');
    expect(userMessage.content).toContain('Attachment: example.ts');
    expect(userMessage.content).toContain('```');
    expect(userMessage.content).toContain('export const answer = 42;');
  });

  it('does not leak Telegram photo temp paths or generated names into the LLM context', async () => {
    const chatId = 'photo_temp_path_test';
    const client = makeMockClient('photo ok');
    const generatedName = '1777043230219-usba99-AgACAgQAAxkBAAIJDmnrhx3BEh39emsoHfC3Sd8bSW4G.jpg';
    const incoming: IncomingMessage = {
      ...makeMsg('Analyze this photo', chatId),
      attachments: [{
        type: 'photo',
        path: `workspace/tmp/${generatedName}`,
        mime: 'image/jpeg',
        filename: generatedName,
      }],
    };

    await handleMessage(incoming, 'sys', client);

    const chatCall = (client.chat as ReturnType<typeof vi.fn>).mock.calls[0];
    const messages = chatCall[0] as ChatMessage[];
    const userMessage = messages[messages.length - 1];
    const history = getHistory(chatId);
    const persistedUser = history.find(m => m.role === 'user');

    expect(userMessage.content).toContain('Photo Analysis');
    expect(userMessage.content).toContain('Photo 1');
    expect(userMessage.content).toContain('A mountain with snow.');
    expect(userMessage.content).not.toContain('workspace/tmp/');
    expect(userMessage.content).not.toContain(generatedName);
    expect(persistedUser?.content).not.toContain('workspace/tmp/');
    expect(persistedUser?.content).not.toContain(generatedName);
  });

  it('cancels the turn when the caller-provided external abort signal fires', async () => {
    // Regression: this sixth argument used to be silently dropped, which made
    // the graceful-shutdown drain (and turn-supersede aborts) complete no-ops.
    const controller = new AbortController();
    const client: LLMClient = {
      provider: 'mock',
      chat: vi.fn().mockResolvedValue({
        content: 'unused',
        usage: { input_tokens: 1, output_tokens: 1 },
        model: 'mock-model',
        stop_reason: 'end',
      }),
      async *chatStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'text', text: 'partial output' };
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield { type: 'text', text: ' that keeps going' };
        await new Promise((resolve) => setTimeout(resolve, 5000));
        yield {
          type: 'done',
          response: { content: 'never delivered', usage: { input_tokens: 10, output_tokens: 20 }, model: 'mock-model', stop_reason: 'end' },
        };
      },
    } as unknown as LLMClient;

    setTimeout(() => controller.abort(new Error('Runtime restarting')), 20);

    // onStreamChunk selects the streaming brain path — the one the web UI uses.
    const progress: ProgressCallback = {
      onProcessingStart: () => {},
      onToolStart: () => {},
      onToolEnd: () => {},
      onStreamChunk: () => {},
    };

    const result = await handleMessage(
      makeMsg('long running request', 'external_abort_test'),
      'sys',
      client,
      progress,
      undefined,
      controller.signal,
    );

    // Cancelled turns resolve to an empty response instead of hanging until the
    // stream finishes on its own.
    expect(result).toBe('');
  });

  it('rejects a direct concurrent same-chat message without resetting the active session', async () => {
    const chatId = 'direct_concurrent_turn_test';
    let releaseFirst!: () => void;
    let resolveStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    const firstClient: LLMClient = {
      provider: 'mock',
      chat: vi.fn().mockResolvedValue({
        content: '',
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'mock-model',
        stop_reason: 'end',
      } satisfies ChatResponse),
      async *chatStream(): AsyncGenerator<StreamChunk> {
        resolveStarted();
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        yield { type: 'text', text: 'First response' };
        yield {
          type: 'done',
          response: {
            content: 'First response',
            usage: { input_tokens: 1, output_tokens: 1 },
            model: 'mock-model',
            stop_reason: 'end',
          },
        };
      },
    };
    const progress: ProgressCallback = {
      onProcessingStart: vi.fn(),
      onToolStart: vi.fn(),
      onToolEnd: vi.fn(),
      onStreamChunk: vi.fn(),
      onStreamEnd: vi.fn(),
    };
    const firstResult = handleMessage(makeMsg('first', chatId), 'sys', firstClient, progress);

    await firstStarted;
    const sessionBefore = __getInMemorySessionForTests(chatId);
    const activeBefore = getActiveTurnForChat(chatId, 'default');
    expect(sessionBefore?.state).toBe('WORKING');
    expect(activeBefore).not.toBeNull();

    const secondClient = makeMockClient('Second response should not run');
    const secondResult = await handleMessage(makeMsg('second', chatId), 'sys', secondClient);

    expect(secondResult).toContain('previous request is still running');
    expect(secondClient.chat).not.toHaveBeenCalled();
    expect(__getInMemorySessionForTests(chatId)).toBe(sessionBefore);
    expect(getActiveTurnForChat(chatId, 'default')?.turnId).toBe(activeBefore?.turnId);

    releaseFirst();
    await expect(firstResult).resolves.toBe('First response');
  });
});

describe('turn telemetry wiring (live path)', () => {
  it('opens a turn trace, persists a prompt snapshot, records tool spans, and completes with aggregated usage', async () => {
    const chatId = 'telemetry_wiring_chat';
    const responses: ChatResponse[] = [
      {
        content: '',
        tool_calls: [{
          id: 'tc_telemetry_span',
          type: 'function',
          function: { name: 'unknown_tool', arguments: '{"probe":true}' },
        }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 80 },
        model: 'mock-model',
        stop_reason: 'tool-calls',
      },
      {
        content: 'telemetry final reply',
        usage: { input_tokens: 150, output_tokens: 30, cache_read_tokens: 120 },
        model: 'mock-model',
        stop_reason: 'end',
      },
      {
        content: 'background ok',
        usage: { input_tokens: 0, output_tokens: 0 },
        model: 'mock-model',
        stop_reason: 'end',
      },
    ];
    let callIndex = 0;
    const client: LLMClient = {
      provider: 'mock',
      // Honor the usageCollector contract the way the real AI SDK adapter does,
      // so the handler-side aggregation is exercised end-to-end.
      chat: vi.fn(async (_messages: ChatMessage[], options?: ChatOptions) => {
        const response = responses[Math.min(callIndex, responses.length - 1)];
        callIndex += 1;
        options?.usageCollector?.add(response.usage);
        return response;
      }),
      async *chatStream(): AsyncGenerator<StreamChunk> {
        yield { type: 'done', response: responses[1] };
      },
    };

    await handleMessage(makeMsg('probe telemetry', chatId), 'sys', client);

    const db = getDb();
    const trace = db.prepare('SELECT * FROM turn_traces WHERE chat_id = ?').get(chatId) as Record<string, unknown> | undefined;
    expect(trace).toBeDefined();
    expect(trace!.status).toBe('success');
    // First two calls are the brain loop; the third is post-turn background work
    // outside the turn (title/digest) and must NOT be double-counted here.
    expect(trace!.llm_input_tokens).toBe(250);
    expect(trace!.llm_output_tokens).toBe(50);
    expect(trace!.cache_read_tokens).toBe(200);
    expect(trace!.tool_call_count).toBe(1);
    expect(trace!.tool_failure_count).toBe(1);
    expect(trace!.verify_status).toBe('not_required');
    expect(trace!.verify_summary).toContain('No tracked mutations');
    expect(trace!.ended_at).toBeTruthy();

    const spans = db.prepare('SELECT * FROM tool_spans WHERE trace_id = ?').all(trace!.trace_id) as Array<Record<string, unknown>>;
    expect(spans).toHaveLength(1);
    expect(spans[0].tool_name).toBe('unknown_tool');
    expect(spans[0].status).toBe('error');

    const snapshotRow = db.prepare('SELECT snapshot FROM prompt_snapshots WHERE trace_id = ?').get(trace!.trace_id) as { snapshot: string } | undefined;
    expect(snapshotRow).toBeDefined();
    const snapshot = JSON.parse(snapshotRow!.snapshot);
    expect(Array.isArray(snapshot.context.slots)).toBe(true);
    expect(snapshot.context.slots.length).toBeGreaterThan(0);
    expect(snapshot.runtime_meta.message_count).toBeGreaterThan(0);
    expect(snapshot.verifier.verify_status).toBe('not_required');
    expect(snapshot.verifier.summary).toContain('No tracked mutations');
  });

  it('records the enforced admission tool surface and a fail-closed outcome truthfully', async () => {
    const chatId = 'durable_admission_trace_chat';
    const client = makeMockClient('I will build and deliver everything inline.');
    const prompt = 'Build a production-ready SaaS application with authentication, billing, organization roles, an admin dashboard, audit logs, automated tests, Docker packaging, deployment configuration, and operator documentation.';

    const response = await handleMessage(makeMsg(prompt, chatId), 'sys', client);

    expect(response).toContain('runtime blocked inline execution');
    const db = getDb();
    const trace = db.prepare('SELECT * FROM turn_traces WHERE chat_id = ?').get(chatId) as Record<string, unknown>;
    expect(trace.status).toBe('failed');
    const snapshotRow = db.prepare('SELECT snapshot FROM prompt_snapshots WHERE trace_id = ?').get(trace.trace_id) as { snapshot: string };
    const snapshot = JSON.parse(snapshotRow.snapshot);
    expect(new Set(snapshot.tools.map((tool: { name: string }) => tool.name))).toEqual(new Set(['use_skill', 'decompose_task']));
    expect(snapshot.runtime_meta.runtime_admission).toBe('durable_plan');
    expect(snapshot.runtime_meta.admission_status).toBe('blocked');
  });

  it('routes a complex current-plan continuation to plan controls without re-decomposing', async () => {
    const chatId = 'existing_plan_control_chat';
    const created = createPlanTasks({
      goal: 'Existing report plan',
      all_steps_independent: false,
      subtasks: [
        { title: 'Research', objective: 'Collect evidence.', done_criteria: 'Evidence is persisted', depends_on: [], agent_type_hint: 'any', constraints: {} },
        { title: 'Report', objective: 'Generate the report.', done_criteria: 'Report is persisted and verified', depends_on: [0], agent_type_hint: 'any', constraints: {} },
      ],
    }, {
      tenantId: 'default',
      chatId,
      sessionId: 'existing-plan-session',
      systemPrompt: '# SOUL.md — Runtime Identity\nGateway plan-control test.',
    });
    updateStatus(created.rootTaskId, 'running', 'default');
    const prompt = 'Continue the current plan. Step 1: retry the failed research. Step 2: regenerate the final report.';

    const response = await handleMessage(makeMsg(prompt, chatId), 'sys', makeMockClient('I will control the persisted plan.'));

    expect(response).toBe('I will control the persisted plan.');
    const db = getDb();
    const trace = db.prepare('SELECT * FROM turn_traces WHERE chat_id = ? ORDER BY started_at DESC').get(chatId) as Record<string, unknown>;
    const snapshotRow = db.prepare('SELECT snapshot FROM prompt_snapshots WHERE trace_id = ?').get(trace.trace_id) as { snapshot: string };
    const snapshot = JSON.parse(snapshotRow.snapshot);
    expect(snapshot.runtime_meta.runtime_admission).toBe('plan_control');
    expect(snapshot.runtime_meta.admission_status).toBe('accepted');
    expect(snapshot.tools.map((tool: { name: string }) => tool.name)).not.toContain('decompose_task');
    expect(snapshot.tools.map((tool: { name: string }) => tool.name)).toContain('repair_task');
  });
});
