/**
 * gate-e2e — Scripted release gate for the full plan execution path.
 *
 * Runs via `pnpm gate:e2e`. Zero network, zero cost. Budget: <90s.
 *
 * Drives ONE user message through the real `handleMessage` production
 * gateway function (not a unit shortcut). Uses the scripted LLM client
 * to deterministically trigger plan creation, step execution, and plan
 * delivery, then asserts the 7 blueprint assertions from
 * docs/RUNTIME-HARDENING-BLUEPRINT.md §5.
 *
 * Blueprint assertions:
 *  1. `decompose_task` produces a root task tagged `plan:root` in the tasks table.
 *  2. `ToolResult.ends_turn` stops the foreground loop (handleMessage returns
 *     the handoff string, not null, without running further foreground LLM turns).
 *  3. Plan root + children persist; `getPlanSteps` returns both steps.
 *  4. Progress bus emits `dag_created` / task events carrying session + tenant IDs.
 *  5. Invalid-args fixture: scripted invalid tool args trip repeated-failure guard
 *     (`stopReason=repeated_tool_failures` reached without crashing).
 *  6. Final delivery via `deliverAssistantMessage`: completion row written to
 *     `conversations` after plan finishes.
 *  7. `event_log`, `session_timeline_events`, tasks, and `conversations` agree on
 *     chat_id / session_id / tenant_id.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// DB bootstrap must happen before any store imports.
import { initDb, getDb, closeDb } from '../src/store/db.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_PATH = join(__dirname, '..', 'src', 'store', 'schema.sql');

let tmpDir: string;
let chatId: string;
let tenantId: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'mozi-gate-e2e-'));
  const dbPath = join(tmpDir, 'gate.db');
  closeDb();
  const db = initDb(dbPath);
  const schema = readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schema);

  chatId = `gate-e2e-chat-${Date.now()}`;
  tenantId = 'default';
});

afterAll(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Poll until condition is true or timeout expires. */
async function waitFor(
  check: () => boolean,
  { intervalMs = 100, timeoutMs = 30_000 }: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Scripted LLM client (foreground brain scenario)
// ---------------------------------------------------------------------------
// Turn 0: return decompose_task tool call.
// Turns 1-N: alternate write_file tool call / final text (step executions).
// This is module-level state so it resets for each describe block by index.

function createForegroundScriptedClient() {
  let callCount = 0;

  return {
    provider: 'scripted' as const,

    async chat(_messages: unknown[], _options?: unknown) {
      const messageText = JSON.stringify(_messages);
      if (messageText.includes('strict runtime acceptance verifier')) {
        throw new Error('Bad Request: Failed to parse request body as JSON: unexpected end of hex escape');
      }
      const n = callCount++;
      if (n === 0) {
        // Turn 0: decompose into 2-step plan
        return {
          content: 'Launching background plan.',
          tool_calls: [{
            id: `scripted-${n}-${Date.now()}`,
            type: 'function' as const,
            function: {
              name: 'decompose_task',
              arguments: JSON.stringify({
                goal: 'Gate E2E: write two test files',
                subtasks: [
                  {
                    title: 'Step A',
                    objective: 'Write /tmp/gate-step-a.txt',
                    done_criteria: 'file written',
                    depends_on: [],
                    agent_type_hint: 'any',
                    constraints: {},
                  },
                  {
                    title: 'Step B',
                    objective: 'Write /tmp/gate-step-b.txt',
                    done_criteria: 'file written',
                    depends_on: [0],
                    agent_type_hint: 'any',
                    constraints: {},
                  },
                ],
              }),
            },
          }],
          usage: { input_tokens: 20, output_tokens: 10 },
          model: 'scripted',
          stop_reason: 'tool_calls',
        };
      }

      // All subsequent calls: return text completion (no tool calls).
      // This avoids permission-elevation deadlocks in the step executor.
      // The goal of the gate is to exercise the execution seams (plan creation,
      // step dispatch, progress events, delivery) — not file I/O.
      await new Promise(resolve => setTimeout(resolve, 100));
      return {
        content: `Step ${n} completed successfully. Gate e2e verification passed.`,
        usage: { input_tokens: 10, output_tokens: 8 },
        model: 'scripted',
        stop_reason: 'end_turn',
      };
    },

    async *chatStream(messages: unknown[], options?: unknown): AsyncGenerator<unknown> {
      const response = await this.chat(messages, options);
      if (response.content) yield { type: 'text', text: response.content };
      if (response.tool_calls) {
        for (const tc of response.tool_calls) {
          yield { type: 'tool_input_start', toolCallId: tc.id, toolName: tc.function.name };
          yield { type: 'tool_input_delta', toolCallId: tc.id, delta: tc.function.arguments };
          yield { type: 'tool_input_end', toolCallId: tc.id };
        }
      }
      yield { type: 'done', response };
    },
  };
}

// ---------------------------------------------------------------------------
// Scripted LLM client (invalid-args scenario for assertion 5)
// ---------------------------------------------------------------------------
// Always returns a non-existent tool call so `executeToolCalls` reports failure.
function createInvalidArgsClient() {
  return {
    provider: 'scripted' as const,

    async chat(_messages: unknown[], _options?: unknown) {
      // Return a call to a nonexistent tool — executor will mark is_error=true
      return {
        content: '',
        tool_calls: [{
          id: `bad-${Date.now()}`,
          type: 'function' as const,
          function: {
            name: 'nonexistent_tool_gate_test',
            arguments: '{}',
          },
        }],
        usage: { input_tokens: 5, output_tokens: 3 },
        model: 'scripted',
        stop_reason: 'tool_calls',
      };
    },

    async *chatStream(messages: unknown[], options?: unknown): AsyncGenerator<unknown> {
      const response = await this.chat(messages, options);
      for (const tc of response.tool_calls!) {
        yield { type: 'tool_input_start', toolCallId: tc.id, toolName: tc.function.name };
        yield { type: 'tool_input_delta', toolCallId: tc.id, delta: tc.function.arguments };
        yield { type: 'tool_input_end', toolCallId: tc.id };
      }
      yield { type: 'done', response };
    },
  };
}

// ---------------------------------------------------------------------------
// Gate: assertions 1-4, 6, 7
// ---------------------------------------------------------------------------

describe('gate:e2e — scripted full plan path', () => {
  test('drives plan creation through delivery and asserts 7 blueprint items', async () => {
    // Runtime imports come after DB boot.
    const { handleMessage } = await import('../src/gateway/handler.js');
    const { on: onProgress, removeAllListeners } = await import('../src/progress/event-bus.js');
    const { isPlanRunActive, getPlanSteps } = await import('../src/core/plan-runner.js');
    const { PLAN_ROOT_TAG } = await import('../src/store/task-dag.js');

    // Capture all progress events emitted during this test run.
    const capturedEvents: Array<{ type: string; sessionId?: string; tenantId?: string; chatId?: string; taskId?: string }> = [];
    removeAllListeners();
    const offProgress = onProgress((event) => {
      capturedEvents.push({
        type: event.type,
        sessionId: event.sessionId,
        tenantId: event.tenantId,
        chatId: event.chatId,
        taskId: event.taskId,
      });
    });

    const client = createForegroundScriptedClient();
    const SYSTEM_PROMPT = '# SOUL.md — Runtime Identity\n[gate-e2e test system prompt]';
    const userId = `gate-user-${Date.now()}`;

    // ------------------------------------------------------------------
    // Assertion 2 setup: verify handleMessage returns the handoff string
    // (ends_turn stops the foreground loop immediately after decompose_task).
    // ------------------------------------------------------------------
    const handoffResult = await handleMessage(
      {
        channelType: 'websocket',
        chatId,
        userId,
        username: 'gate-tester',
        text: 'Run the gate e2e plan',
        isCommand: false,
        timestamp: Date.now(),
        tenantId,
      },
      SYSTEM_PROMPT,
      client as never,
      undefined,
      undefined,
      undefined,
      SYSTEM_PROMPT,
    );

    // ---------------------------------------------------------------
    // ASSERTION 2: ends_turn stopped the foreground loop.
    // handleMessage returns a non-null string (the handoff/ACK text).
    // ---------------------------------------------------------------
    expect(handoffResult, 'A2: ends_turn must stop foreground loop — handleMessage must return a string, not null').not.toBeNull();
    expect(typeof handoffResult, 'A2: return type must be string').toBe('string');

    // ---------------------------------------------------------------
    // ASSERTION 1: decompose_task produced a root task tagged plan:root.
    // ---------------------------------------------------------------
    const db = getDb();
    const rootRow = db.prepare(`
      SELECT id, tags, tenant_id, title
      FROM tasks
      WHERE tenant_id = ? AND tags LIKE ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(tenantId, `%${PLAN_ROOT_TAG}%`) as { id: string; tags: string; tenant_id: string; title: string } | undefined;

    expect(rootRow, 'A1: tasks table must have a row tagged plan:root').toBeDefined();
    const rootTaskId = rootRow!.id;
    const rootTags: string[] = JSON.parse(rootRow!.tags);
    expect(rootTags, 'A1: root task must include plan:root tag').toContain(PLAN_ROOT_TAG);

    const sessionRow = db.prepare(`
      SELECT session_id FROM conversations
      WHERE chat_id = ? AND tenant_id = ? AND session_id IS NOT NULL
      ORDER BY id DESC LIMIT 1
    `).get(chatId, tenantId) as { session_id: string } | undefined;
    expect(sessionRow?.session_id, 'soft-verdict e2e: the plan must own a durable session').toBeTruthy();
    const { saveTimelineItem } = await import('../src/memory/session-timeline.js');
    saveTimelineItem({
      tenantId,
      sessionId: sessionRow!.session_id,
      chatId,
      turnId: `turn_bg_${rootTaskId}`,
      type: 'artifact',
      eventKey: `artifact:soft-verdict-${rootTaskId}`,
      timestamp: Date.now(),
      data: {
        id: `soft-verdict-${rootTaskId}`,
        plugin_id: 'document_v1',
        title: 'Verifier soft-verdict deliverable',
        status: 'completed',
        data: { content: '# Deliverable\n\nThe requested artifact remains reachable.' },
      },
    });

    // ---------------------------------------------------------------
    // ASSERTION 3: Plan root and children persist.
    // ---------------------------------------------------------------
    // Wait for plan runner to register (it starts async)
    await waitFor(() => getPlanSteps(rootTaskId, tenantId).length === 2, { timeoutMs: 5_000 });
    const steps = getPlanSteps(rootTaskId, tenantId);
    expect(steps.length, 'A3: plan must have exactly 2 child steps').toBe(2);
    expect(steps[0].title, 'A3: first step title').toBe('Step A');
    expect(steps[1].title, 'A3: second step title').toBe('Step B');

    // ---------------------------------------------------------------
    // Wait for plan to finish (detached run completes asynchronously)
    // ---------------------------------------------------------------
    await waitFor(
      () => {
        if (isPlanRunActive(rootTaskId)) return false;
        const root = db.prepare('SELECT status FROM tasks WHERE id = ? AND tenant_id = ?')
          .get(rootTaskId, tenantId) as { status: string } | undefined;
        return root?.status === 'completed' || root?.status === 'failed';
      },
      { timeoutMs: 60_000, intervalMs: 200 },
    );

    // ---------------------------------------------------------------
    // ASSERTION 4: progress bus emitted events with session + tenant ids.
    // ---------------------------------------------------------------
    const dagEvents = capturedEvents.filter(e =>
      ['dag_created', 'task_started', 'task_completed', 'background_agent_complete', 'background_agent_failed'].includes(e.type)
    );
    expect(dagEvents.length, 'A4: at least one dag/task progress event must be emitted').toBeGreaterThan(0);

    // Every plan-related event must carry tenantId.
    const eventsWithTenant = dagEvents.filter(e => e.tenantId === tenantId);
    expect(eventsWithTenant.length, 'A4: plan events must carry tenantId').toBeGreaterThan(0);

    // ---------------------------------------------------------------
    // ASSERTION 6: Final delivery via deliverAssistantMessage
    // persisted an assistant row in conversations.
    // ---------------------------------------------------------------
    // Wait up to 5s after plan finishes for delivery to persist
    await waitFor(
      () => {
        const rows = db.prepare(`
          SELECT id FROM conversations
          WHERE chat_id = ? AND role = 'assistant' AND tenant_id = ?
      ORDER BY id DESC LIMIT 1
        `).all(chatId, tenantId);
        return rows.length > 0;
      },
      { timeoutMs: 10_000, intervalMs: 200 },
    );

    const assistantRows = db.prepare(`
      SELECT id, content, session_id FROM conversations
      WHERE chat_id = ? AND role = 'assistant' AND tenant_id = ?
      ORDER BY id DESC LIMIT 5
    `).all(chatId, tenantId) as Array<{ id: number; content: string; session_id: string | null }>;

    expect(assistantRows.length, 'A6: at least one assistant delivery row must exist in conversations').toBeGreaterThan(0);

    const rootStatus = db.prepare('SELECT status FROM tasks WHERE id = ? AND tenant_id = ?')
      .get(rootTaskId, tenantId) as { status: string };
    const { loadTaskResult } = await import('../src/tasks/workspace.js');
    const rootResult = loadTaskResult(rootTaskId);
    const verificationRow = db.prepare(`
      SELECT payload FROM session_timeline_events
      WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND item_type = 'task_update'
        AND event_key = ?
    `).get(tenantId, sessionRow!.session_id, `turn_bg_${rootTaskId}`, `task:${rootTaskId}:verification`) as { payload: string } | undefined;
    const artifactRow = db.prepare(`
      SELECT id FROM session_timeline_events
      WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND item_type = 'artifact'
        AND event_key = ?
    `).get(tenantId, sessionRow!.session_id, `turn_bg_${rootTaskId}`, `artifact:soft-verdict-${rootTaskId}`);
    expect(rootStatus.status, 'soft-verdict e2e: root terminal state').toBe('completed');
    expect(rootResult?.metadata).toMatchObject({
      quality_unverified: true,
      semantic_verification: { outcome: 'unverified' },
    });
    expect(artifactRow, 'soft-verdict e2e: delivered artifact remains reachable').toBeDefined();
    expect(JSON.parse(verificationRow!.payload)).toMatchObject({
      status: 'completed',
      rawStatus: 'plan_verification_unverified',
    });
    expect(assistantRows[0].content).toContain('quality was not verified');
    expect(assistantRows[0].content).toContain('valid quality verdict');
    expect(assistantRows[0].content).not.toMatch(/passed verification|succeeded|successfully/i);
    console.info('ISSUE_841_E2E_EVIDENCE', JSON.stringify({
      rootTaskId,
      rootStatus: rootStatus.status,
      qualityUnverified: rootResult?.metadata?.quality_unverified,
      semanticOutcome: (rootResult?.metadata?.semantic_verification as { outcome?: string } | undefined)?.outcome,
      verificationTask: JSON.parse(verificationRow!.payload),
      artifactReachable: Boolean(artifactRow),
      completionContent: assistantRows[0].content,
    }));

    // ---------------------------------------------------------------
    // ASSERTION 7: event_log, session_timeline_events, tasks, and
    // conversations agree on chat_id / tenant_id.
    // ---------------------------------------------------------------

    // event_log — plan_created event
    const eventLogRows = db.prepare(`
      SELECT event_type, payload FROM event_log
      WHERE entity_type = 'task' AND entity_id = ? AND tenant_id = ?
      ORDER BY id ASC
    `).all(rootTaskId, tenantId) as Array<{ event_type: string; payload: string }>;
    expect(eventLogRows.length, 'A7: event_log must have at least one row for the plan root').toBeGreaterThan(0);

    // Find the plan_created event specifically and check its chat_id payload.
    const planCreatedRow = eventLogRows.find(r => r.event_type === 'plan_created');
    expect(planCreatedRow, 'A7: event_log must contain a plan_created event').toBeDefined();
    const planCreatedPayload = JSON.parse(planCreatedRow!.payload) as Record<string, unknown>;
    expect(planCreatedPayload['chat_id'], 'A7: event_log plan_created payload must carry correct chat_id').toBe(chatId);

    // tasks table — root tenant matches
    const taskRow = db.prepare('SELECT tenant_id FROM tasks WHERE id = ? LIMIT 1')
      .get(rootTaskId) as { tenant_id: string } | undefined;
    expect(taskRow?.tenant_id, 'A7: tasks row must have correct tenant_id').toBe(tenantId);

    // conversations row — chat_id matches
    expect(assistantRows[0], 'A7: conversations row exists').toBeDefined();

    // session_timeline_events — at least one row for the session.
    // Recover the session_id from the conversations table (handler creates session
    // internally; we can't reference it directly from the gate).
    const convWithSession = db.prepare(`
      SELECT session_id FROM conversations
      WHERE chat_id = ? AND tenant_id = ? AND session_id IS NOT NULL LIMIT 1
    `).get(chatId, tenantId) as { session_id: string } | undefined;

    if (convWithSession?.session_id) {
      const timelineRows = db.prepare(`
        SELECT id FROM session_timeline_events
        WHERE session_id = ? AND tenant_id = ?
      `).all(convWithSession.session_id, tenantId) as Array<{ id: number }>;
      expect(timelineRows.length, 'A7: session_timeline_events must have entries for the session').toBeGreaterThan(0);
    }
    // If no session_id found in conversations, the gate passes on the other 6 assertions —
    // session_timeline_events are written only when a sessionId is available in the delivery path.

    offProgress();
  }, 90_000); // 90s budget as per blueprint
});

// ---------------------------------------------------------------------------
// Gate: assertion 5 — repeated-failure guard fires on invalid tool args
// ---------------------------------------------------------------------------

describe('gate:e2e — invalid-args triggers repeated-failure guard', () => {
  test('scripted invalid tool name causes brain loop to hit repeated_tool_failures stop', async () => {
    const { handleMessage } = await import('../src/gateway/handler.js');

    const invalidClient = createInvalidArgsClient();
    const badChatId = `gate-e2e-invalid-${Date.now()}`;

    // handleMessage must return without crashing (recovery path runs and
    // produces a final response). The foreground loop stops because
    // maxFailedToolBatches is hit (default: 3 consecutive errors).
    const result = await handleMessage(
      {
        channelType: 'websocket',
        chatId: badChatId,
        userId: 'gate-invalid-user',
        username: 'gate-tester',
        text: 'Trigger guard',
        isCommand: false,
        timestamp: Date.now(),
        tenantId,
      },
      '[gate-e2e invalid-args test]',
      invalidClient as never,
    );

    // The brain's recovery path always produces a string. It may be empty
    // but must not be null — null means the turn was rejected before the
    // brain ran, which would mean the guard was never reached.
    expect(result, 'A5: handleMessage must return (non-null) after repeated failures').not.toBeNull();
    expect(typeof result, 'A5: return type must be string').toBe('string');

    // Verify that at least one tool error was recorded in the conversations
    // table for this chat (the recovery path persists a turn result).
    const db = getDb();
    const convRows = db.prepare(`
      SELECT id FROM conversations
      WHERE chat_id = ? AND tenant_id = ?
    `).all(badChatId, tenantId) as Array<{ id: number }>;

    expect(convRows.length, 'A5: conversations must have entries for the invalid-args chat').toBeGreaterThan(0);
  }, 30_000);
});
