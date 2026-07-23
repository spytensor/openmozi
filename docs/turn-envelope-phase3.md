# Turn Envelope — Phase 3 (Issue #626)

Truthful cancel, retry, reconnect, background, and interruption lifecycle. Phase 3
makes the durable Turn Envelope the **authoritative** source for these transitions
end-to-end (producer → persistence → restore → projection → UI). It builds on the
Phase 0 contract (`docs/turn-envelope-phase0.md`): turn identity + per-turn
sequence, `session_turns` envelopes, the `saveTimelineItem` choke point.

## What changed

### 1. Projection consumes the full envelope lifecycle (was: completed/failed only)
`ui/src/components/chat/turn-projection.ts` now re-colors an execution block that is
still shaped `running` on restore from the **envelope terminal status**, not just
`completed`/`failed`:

| Envelope status | Projected block status |
|---|---|
| `completed` | `success` |
| `failed` | `error` |
| `cancelled` | `cancelled` (new) |
| `interrupted` | `interrupted` (new) |
| `active` / `awaiting_approval` | left `running` (genuinely open) |

`ExecutionState` gained `cancelled | interrupted` (`execution.ts`). `ExecutionBlock`
freezes an `interrupted` block (no spinner, "Interrupted — runtime restarted…") and
reads an `cancelled` block as stopped, not failed. New EN/ZH copy:
`execution.headline.cancelled` (Stopped / 已停止), `execution.headline.interrupted`
(Interrupted / 已中断). This is what carries an abort or a crash-interruption to the
UI on reconnect/reload — the authoritative path, complementing the existing live
client heuristics.

### 2. Background completion cannot attach to a foreground turn
A detached plan (`src/core/plan-runner.ts`) is now its **own** background turn, not
part of the foreground turn that spawned it:
- `planBackgroundTurnId(rootTaskId) = turn_bg_<rootTaskId>` — stable across resume.
- `runPlan` records `startTurnEnvelope({ origin: 'background', turnId, … })` and
  terminalizes it `completed`/`failed`.
- That id is threaded into `executeDag` **and** the plan's `ToolContext.turnId`, so
  every step tool/artifact event groups under the background turn (the executor
  already emits `context.turnId`).
- `deliverAssistantMessage` (the plan-completion delivery, its only live caller) no
  longer backfills `getActiveTurnForChat`. It carries its own `origin`/`turnId`; a
  self-contained delivery is a born-and-done background turn.

This closes the concrete attach bug: previously a plan finishing while a *new*,
unrelated foreground turn was active would stamp that turn's id onto the plan's
completion message via registry backfill.

### 3. Retry / regenerate = new turn identity, prior turns preserved
Regenerate is append-only: the original prompt, answer, artifacts, and lifecycle
remain visible and immutable. The gateway mints a new `turnId`, and
`cloneLatestUserMessageToTurn` copies the latest prompt into that retry turn with a
fresh `turn_seq = 1`. The UI immediately presents the cloned prompt as a distinct
retry while preserving the prior turn. The new answer then lands in the same retry
turn. This keeps every attempt coherent and makes comparison and audit possible.

## Producer → consumer wiring

| Transition | Writer (producer) | Persisted as | Consumer |
|---|---|---|---|
| user cancel | `publishTurnState('CANCELLED')` → `setTurnEnvelopeStatus('cancelled')` | `session_turns.status` | projection → block `cancelled`; App system notice `chat.stoppedByUser` |
| crash / restart | `terminalizeStaleActiveTurns()` on startup | `session_turns.status='interrupted'` | projection → block `interrupted`; App `chat.interruptedByRestart` |
| approval wait | `waitForApprovalDecisionForTurn` → `awaiting_approval`/`active` | `session_turns.status` | left open (approval card is the explicit surface) |
| background plan run | `plan-runner` `startTurnEnvelope(origin='background')` + terminal | `session_turns` (origin background) | projection groups as its own turn, ordered by `startedAt` |
| background completion msg | `deliverAssistantMessage(turnId, origin)` | timeline row under background turn | restore/projection |
| regenerate | gateway new `turnId` + `cloneLatestUserMessageToTurn` | a new user row under the retry turn; prior rows unchanged | deterministic projection (distinct coherent attempts) |

## Tests (producer → UI)
- `ui/src/components/chat/turn-projection.test.ts` — cancelled/interrupted override,
  awaiting_approval stays open, background turn renders as its own ordered group.
- `ui/src/components/chat/ExecutionBlock.test.tsx` — envelope-cancelled/interrupted
  render (no spinner) + zh-CN.
- `src/channels/websocket.turn-contract.test.ts` — out-of-turn delivery does NOT
  adopt the active foreground turn; explicit caller-owned turn keeps its status.
- `src/core/plan-runner.test.ts` — plan runs under `turn_bg_*` (not the foreground
  turn), delivers with `origin='background'`, envelope terminalized.
- `src/memory/session-timeline.test.ts` — `cloneLatestUserMessageToTurn` preserves
  the original and copies the prompt onto the new turn with a fresh sequence.

## Not done here (honest boundaries)
- **Runtime UI evidence** (Web/Docker + installed macOS App screenshots for cancel /
  retry / approval wait / disconnect-reconnect / forced restart / foreground+
  background) is required by the #623 merge gate and is **not** produced by this
  implementation pass — it is the reviewer's verification step (see #626 comment).
  Static analysis + unit tests only.
- **Graceful-shutdown drain** still maps to `cancelled` (via `cancelAllRunningTurns`
  → `publishTurnState('CANCELLED')`); only a hard crash yields `interrupted` (startup
  sweep). A restart-drain reason reads as cancellation, not interruption.
- Scheduler/proactive `notify()` deliveries remain channel notifications and do not
  create session-timeline turns (they never persisted timeline rows); only the plan
  runner's timeline delivery was in scope for the attach fix.
