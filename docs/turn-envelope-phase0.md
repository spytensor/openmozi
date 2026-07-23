# Turn Envelope — Phase 0 contract (Issue #627)

Server-authoritative turn identity and deterministic per-turn ordering. This
phase is additive plumbing only: **no visible UI behavior changes yet.**

## Vocabulary (`src/core/turn-envelope.ts`)
- `TurnOrigin`: `user | system | proactive | background | scheduler`.
- `TurnStatus`: `active | awaiting_approval | completed | failed | cancelled | interrupted`.
- `TIMELINE_CAPABILITY = 'timeline_v1'`, advertised in the WS `welcome` frame via
  `SERVER_TIMELINE_CAPABILITIES`.

## The server-owned choke point
`saveTimelineItem` (`src/memory/session-timeline.ts`) is the single writer for the
rendered timeline. It assigns a durable per-turn monotonic sequence (`turn_seq`)
to every turn-scoped row and returns `{ turnId, seq }`. On update it preserves
the row's first-assigned sequence; a merge-update that omits `turn_id`
(e.g. artifact patch) keeps the existing identity via `COALESCE`.

## Turn identity sourcing
- Producers on the tool / task / approval / worker paths stamp `turnId` directly.
- Stream, artifact, and out-of-turn message paths carry only a chat scope; the WS
  layer backfills identity from the server-authoritative active-turn registry
  (`getActiveTurnForChat`) via `resolveActiveTurnId`, so identity comes from one
  source of truth instead of each producer re-deriving it.
- The **synchronous non-streamed reply** persists *after* the turn is
  unregistered, so the registry can no longer answer. `handleMessage` stamps the
  server-authoritative id onto the shared `IncomingMessage` (`msg.turnId`) once
  the turn is registered; the WS layer reads it back so the final persisted row
  and the outgoing `message` frame both carry the real `turnId` + assigned `seq`.
- The **first message of a brand-new Web chat** carries no `sessionId` (the client
  has none yet) and arrives on the client-scoped chat id `userId:clientId`
  (`buildWebSocketChatId` falls back to the connection id). Two surfacings keep its
  streamed/artifact/final rows on the real session:
  1. `handleMessage` owns/creates the `dbSession` and stamps `msg.sessionId =
     dbSession.id` **before any progress callback fires**, so
     `deliverStreamEvent` / `broadcastArtifactEvent` (which persist only when
     `sessionId && targetUserId`) target the created session instead of dropping
     the row. The WS adapter mirrors that id back onto the transport message so the
     non-stream final reply and its frame also carry the session.
  2. `registerRunningTurn` additionally indexes the turn under the canonical
     `userId:sessionId` key (not only the incoming client-scoped chat id), so
     `resolveActiveTurnId`'s canonical-key lookup backfills the correct `turnId`
     onto those streamed rows. Without this the assistant row persisted with a
     null `turn_id`/`seq` and never shared the user row's turn. Established
     sessions already arrive on `userId:sessionId`, so the alias is a no-op there.

## Persistence + restore
- `session_timeline_events.turn_seq` (additive column) — per-event sequence.
- `session_turns` (new table) — one Turn Envelope per turn: origin, status,
  `seq_high_water`, `started_at`, `ended_at`. Written by the gateway handler
  (`startTurnEnvelope` + `setTurnEnvelopeStatus` mirroring control-plane
  **terminal** transitions: DONE/FAILED/CANCELLED). The transient
  `awaiting_approval` status is written by the tool loop's real approval pause
  (`waitForApprovalDecisionForTurn`), not by the turn FSM. Interrupted turns are
  terminalized on startup (`terminalizeStaleActiveTurns`).
- Restore: `GET /api/sessions/:id/timeline` returns `seq`/`turnId` per item and a
  `turns` array (first page). Legacy rows have `turn_seq = NULL` and are unchanged.

## Producer → consumer wiring

| Producer | Identity | Sequence | Persist writer | WS frame |
|---|---|---|---|---|
| tool_call / tool_result | producer `turnId`, else registry | choke point | `persistToolEventTimeline` | `tool_event.seq` |
| task lifecycle | producer `turnId`, else registry | choke point | `persistTaskUpdateTimeline` | `task_update.seq` |
| worker_status | producer `turnId`, else registry | choke point | `persistTaskProgressTimeline` | `task_progress.seq` |
| approval req/resolved | producer `turnId`, else registry | choke point | inline / `persistApprovalResolvedTimeline` | `approval_*.seq` |
| assistant stream | registry backfill | choke point | `deliverStreamEvent` | `stream_*.seq` |
| artifact open | registry backfill | choke point | `broadcastArtifactEvent` | `artifact_open.seq` |
| out-of-turn message | registry backfill | choke point | `deliverAssistantMessage` | `message.seq` |
| synchronous final reply | `msg.turnId` (handler-stamped), else registry | choke point | `saveTimelineItem` (WS route) | `message.turnId` + `message.seq` |
| turn envelope (start / terminal) | gateway handler | — | `startTurnEnvelope` / `setTurnEnvelopeStatus` | `active_turn` (existing) |
| turn envelope (`awaiting_approval`) | tool loop, real approval pause | — | `setTurnEnvelopeStatus` via `waitForApprovalDecisionForTurn` | — |

## Intentionally deferred (out of Phase 0 scope)
- **Client projection**: the UI still renders via its existing heuristics. Types
  carry `turnId`/`seq` but no projection change (Phase 1, #625).
- **Artifact `patch`/`close` live frames** carry `turnId` but not `seq` (throttled
  path has no single assignment point); the persisted row keeps the open row's
  seq, and restore returns it.
- **AI-SDK-adapter tool events** omit `sessionId` and never reach the Web UI
  timeline; not modified.
- **Agent-lifecycle / budget / context-compression** progress events are not
  persisted to the Web UI timeline; unchanged.
- **Non-`user` origins** (background/proactive/scheduler) are vocabulary only;
  those runtimes do not yet write envelopes (Phase 3, #626).
- **No historical backfill**: legacy rows keep `turn_seq = NULL` by design.
