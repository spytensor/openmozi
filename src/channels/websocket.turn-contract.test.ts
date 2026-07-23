/**
 * Turn Envelope contract / liveness test (Issue #627).
 *
 * Proves that every interactive event which persists to the Web UI timeline
 * carries turn identity (`turn_id`) and a durable per-turn monotonic sequence
 * (`turn_seq`) once it flows through the real broadcast/persistence path — not
 * only when a producer happens to stamp the turn id itself. Persistence runs
 * regardless of connected clients, so no sockets are required.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  broadcastProgressEvent,
  broadcastStreamEvent,
  broadcastArtifactEvent,
  broadcastMemoryUpdate,
  deliverAssistantMessage,
} from './websocket.js';
import { getDb } from '../store/db.js';
import { setupTestDb, teardownTestDb } from '../test-helpers.js';
import { registerRunningTurn, clearRunningTurnsForTests } from '../core/turn-cancellation.js';
import { startTurnEnvelope, setTurnEnvelopeStatus } from '../memory/turn-envelopes.js';

const TENANT = 'default';
const USER = 'u1';
const SESSION = 's1';
const CHAT = `${USER}:${SESSION}`; // buildWebSocketChatId(client, session)

interface Row {
  item_type: string;
  turn_id: string | null;
  turn_seq: number | null;
  event_key: string;
}

function timelineRows(): Row[] {
  return getDb().prepare(`
    SELECT item_type, turn_id, turn_seq, event_key
    FROM session_timeline_events
    WHERE tenant_id = ? AND session_id = ?
    ORDER BY id ASC
  `).all(TENANT, SESSION) as Row[];
}

let tmpDir: string;

beforeEach(() => {
  clearRunningTurnsForTests();
  tmpDir = setupTestDb().tmpDir;
});

afterEach(() => {
  clearRunningTurnsForTests();
  teardownTestDb(tmpDir);
});

describe('Issue #627 — interactive event turn-identity + sequence contract', () => {
  it('stamps turn_id and turn_seq on every persisted interactive path', () => {
    // One active turn registered under the canonical websocket chat key.
    const turn = registerRunningTurn({ turnId: 'turn_A', tenantId: TENANT, chatId: CHAT, userId: USER, sessionId: SESSION });

    // 1. Assistant stream (producer supplies NO turnId — must be backfilled).
    broadcastStreamEvent('stream_end', 'req-1', 'final answer', USER, SESSION, TENANT);

    // 2. Artifact open (producer supplies NO turnId).
    broadcastArtifactEvent(
      { type: 'open', artifact: { id: 'art-1', plugin_id: 'p', title: 'A', status: 'running', fallback_text: '', data: {} } },
      USER, SESSION, TENANT,
    );

    // 3. Tool event with an explicit producer turnId.
    broadcastProgressEvent({
      type: 'tool_call', toolName: 'shell', toolCallId: 'call-1', intent: 'ls',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1000,
    });

    // 4. Tool event WITHOUT a producer turnId — must be backfilled from registry.
    broadcastProgressEvent({
      type: 'tool_result', toolName: 'shell', toolCallId: 'call-2', result: 'ok',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, timestamp: 1001,
    });

    // 5. Task lifecycle event.
    broadcastProgressEvent({
      type: 'task_started', taskId: 't-1', taskTitle: 'Build',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1002,
    });

    // 6. Approval request.
    broadcastProgressEvent({
      type: 'approval_request', approvalRequestId: 'appr-1', description: 'Elevate?', approvalAction: 'permission_elevation',
      chatId: CHAT, tenantId: TENANT, sessionId: SESSION, turnId: 'turn_A', timestamp: 1003,
    });

    turn.finish();

    const rows = timelineRows();
    // Every interactive category is represented.
    expect(new Set(rows.map((r) => r.item_type))).toEqual(
      new Set(['message', 'artifact', 'tool_event', 'task_update', 'approval_request']),
    );
    // CONTRACT: no persisted interactive row bypasses turn identity or sequence.
    for (const row of rows) {
      expect(row.turn_id, `turn_id missing on ${row.event_key}`).toBe('turn_A');
      expect(row.turn_seq, `turn_seq missing on ${row.event_key}`).not.toBeNull();
      expect(row.turn_seq as number).toBeGreaterThan(0);
    }
    // Sequences are unique and gap-free within the turn.
    const seqs = rows.map((r) => r.turn_seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
  });

  it('leaves turn identity absent when no turn is active (legacy / turn-less path)', () => {
    // No registerRunningTurn — a stream with no active turn must not fabricate one.
    broadcastStreamEvent('stream_end', 'req-x', 'orphan', USER, SESSION, TENANT);
    const rows = timelineRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_id).toBeNull();
    expect(rows[0].turn_seq).toBeNull();
  });

  it('persists a memory update as a durable, turn-owned timeline event', () => {
    startTurnEnvelope({ tenantId: TENANT, sessionId: SESSION, chatId: CHAT, turnId: 'turn_memory', origin: 'user', startedAt: 10 });

    broadcastMemoryUpdate({
      targetUserId: USER,
      tenantId: TENANT,
      chatId: CHAT,
      sessionId: SESSION,
      turnId: 'turn_memory',
      updates: [
        { factId: 41, action: 'ADD' },
        { factId: 42, action: 'REINFORCE' },
      ],
    });

    const row = getDb().prepare(`
      SELECT item_type, turn_id, turn_seq, event_key, payload
      FROM session_timeline_events
      WHERE tenant_id = ? AND session_id = ? AND event_key = ?
    `).get(TENANT, SESSION, 'memory:turn_memory') as Row & { payload: string };
    expect(row.item_type).toBe('memory_update');
    expect(row.turn_id).toBe('turn_memory');
    expect(row.turn_seq).toBe(1);
    expect(JSON.parse(row.payload)).toMatchObject({ count: 2, added: 1, reinforced: 1, updated: 0, factIds: [41, 42] });
  });
});

function sessionTurn(turnId: string): { origin: string; status: string } | undefined {
  return getDb().prepare(
    `SELECT origin, status FROM session_turns WHERE tenant_id = ? AND session_id = ? AND turn_id = ?`,
  ).get(TENANT, SESSION, turnId) as { origin: string; status: string } | undefined;
}

describe('Issue #626 — out-of-turn delivery cannot attach to a foreground turn', () => {
  it('persists a plan artifact under the caller-owned background turn', () => {
    const foreground = registerRunningTurn({ turnId: 'turn_A', tenantId: TENANT, chatId: CHAT, userId: USER, sessionId: SESSION });
    startTurnEnvelope({
      tenantId: TENANT,
      sessionId: SESSION,
      chatId: CHAT,
      turnId: 'turn_bg_plan-artifact',
      origin: 'background',
      startedAt: 10,
    });

    broadcastArtifactEvent(
      { type: 'open', artifact: { id: 'plan-artifact', plugin_id: 'document_v1', title: 'Plan output', status: 'completed', fallback_text: '', data: {} } },
      USER,
      SESSION,
      TENANT,
      'turn_bg_plan-artifact',
    );
    foreground.finish();

    const artifactRow = timelineRows().find((row) => row.item_type === 'artifact');
    expect(artifactRow?.turn_id).toBe('turn_bg_plan-artifact');
    expect(artifactRow?.turn_seq).toBe(1);
  });

  it('gives a background completion its OWN turn instead of backfilling the active foreground turn', () => {
    // A foreground turn is running on this exact session when a detached background
    // plan completes. The old behavior backfilled `turn_A` onto the plan message.
    const turn = registerRunningTurn({ turnId: 'turn_A', tenantId: TENANT, chatId: CHAT, userId: USER, sessionId: SESSION });

    deliverAssistantMessage({ tenantId: TENANT, chatId: CHAT, sessionId: SESSION, content: 'plan done' });
    turn.finish();

    const messages = timelineRows().filter((r) => r.item_type === 'message');
    expect(messages).toHaveLength(1);
    // The completion is NOT attached to the foreground turn.
    expect(messages[0].turn_id).not.toBe('turn_A');
    expect(messages[0].turn_id).toMatch(/^turn_bg_/);
    // A self-contained delivery is born-and-done as its own background turn.
    expect(sessionTurn(messages[0].turn_id as string)).toEqual({ origin: 'background', status: 'completed' });
  });

  it('delivers under an explicit caller-owned background turn without clobbering its status', () => {
    // The plan runner already recorded + terminalized this turn as failed; the
    // completion message must join it, not resurrect it to completed.
    startTurnEnvelope({ tenantId: TENANT, sessionId: SESSION, chatId: CHAT, turnId: 'turn_bg_plan1', origin: 'background', startedAt: 10 });
    setTurnEnvelopeStatus({ tenantId: TENANT, sessionId: SESSION, turnId: 'turn_bg_plan1', status: 'failed' });

    deliverAssistantMessage({
      tenantId: TENANT, chatId: CHAT, sessionId: SESSION, content: 'plan finished with problems',
      turnId: 'turn_bg_plan1', origin: 'background',
    });

    const messages = timelineRows().filter((r) => r.item_type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0].turn_id).toBe('turn_bg_plan1');
    // Caller owns the terminal status: still failed, not flipped to completed.
    expect(sessionTurn('turn_bg_plan1')).toEqual({ origin: 'background', status: 'failed' });
  });
});
