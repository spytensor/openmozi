# Chat Presentation Contract (Issue #735)

Status: normative presentation contract. The durable event log and the
deterministic turn projection (#623/#625/#626/#628) are unchanged; this
contract defines how typed presentation semantics map into Chat and the Run
Workbench.

## Principles

1. **Runtime truth, typed.** Presentation structure (a plan's phases, a
   deliverable's role) travels as typed event/data fields, never as formatted
   prose persisted into assistant messages. Prose freezes layout decisions into
   runtime truth; typed data lets every surface render the same source.
2. **One source per fact.** The chat capsule, Run Workbench, and answer/output
   rows must consume the same projection. No surface re-derives task
   truth from frontend heuristics (tool counts, visual adjacency, regex over
   prose).
3. **Legacy is renderable, never rewritten.** Historical sessions keep their
   prose plan messages and role-less artifacts; new typed events are additive
   and capability-gated. No destructive migration.
4. **Private historical prose is classified at the server boundary.** Known
   legacy verifier verdicts receive `presentationRole: "internal_qa"` only when
   durable turn/artifact facts match that old runtime path. Chat consumes the
   typed marker and never filters user-visible prose by content.

## Typed events

### `plan_started` (timeline item + WS frame), capability `plan_v1`

Emitted by `executeDecomposeTask` (src/core/dag-bridge.ts) when the runtime
admits a detached background plan. Broadcast and persisted through the
`broadcastProgressEvent` → `saveTimelineItem` choke point, so it carries the
server-assigned `(turnId, seq)` like every other timeline row.

```jsonc
{
  "type": "plan_started",
  "plan_id": "task_...",       // durable plan root task id
  "goal": "...",               // the plan's goal, verbatim
  "phases": [                   // ordered; dependsOn refers to phase taskIds
    { "taskId": "task_a", "title": "Collect data", "dependsOn": [] },
    { "taskId": "task_b", "title": "Write report", "dependsOn": ["task_a"] }
  ],
  "locale": "en",              // presentation locale (turn envelope, else inferred from goal)
  "turnId": "turn_...",
  "seq": 7,
  "timestamp": 1752770000000
}
```

- The turn's final assistant message on this path is a **one-sentence handoff**
  (no numbered phase list): the phase list lives here and only here.
- Phase *progress* is not duplicated onto this event: per-step `task_update`
  rows remain the progress truth (the former `/api/sessions/:id/plans` REST
  resource was removed with the floating execution panel — typed timeline
  events are the only progress channel). This event is the plan's *shape*.
- Clients that never learned `plan_v1` simply never see the frame; the timeline
  row is additive and ignored by the frozen legacy renderer (grouped into the
  execution run, never rendered standalone).

### Deliverable role (artifact `data.role`)

One contract across artifact families (`document_v1`, `file_v1`, PDFs, charts,
sheets, decks, managed-worker outputs — all file kinds flow through these two
plugin ids):

- `role: "primary"` — the thing the user asked for. Stamped server-side:
  `file_v1` via `curateDeliverables` (rendered/binary document extensions),
  `document_v1` unconditionally at open/convergence (a Brain-authored document
  is a deliverable by construction; failed documents are excluded from latch
  decisions).
- `role: "supporting"` — real output produced on the way (charts embedded in
  the report, render frames, co-produced files). Collapsed behind the primary
  deliverable in the chat; always reachable.
- role absent — the turn produced no primary deliverable; every file leads.

The per-turn primary latch is shared: the filesystem tracker asks the
`ArtifactCoordinator` (`hasPrimaryDocument()`) so a Brain-authored
`document_v1` demotes co-produced files exactly like a scanned `report.pdf`
does. The client (`isSupportingArtifact`) groups on `data.role` alone — plugin
id is not consulted, so both families follow the same rule.

## Presentation state matrix

The states every surface must render truthfully. "Card" below refers to the
turn's execution presentation (today's execution block; PR 2's Working Card).

| State | Trigger (runtime truth) | Default chat rendering | Notes |
|---|---|---|---|
| Simple success | Turn ends `completed`, no plan, trivial work | Answer first; no persistent execution residue | `shouldRenderExecutionBlock` policy (#635) |
| Active simple work | Turn `active`, tools running, no plan | Live one-line activity (spinner + current action) | Label from real tool/task events only |
| Active complex work | `plan_started` seen, plan running | Card anchored to originating turn: goal + one current action | No tool/model/adapter identifiers by default |
| Parallel phases | Multiple plan steps `running` concurrently | Card shows one meaningful current action + progress fraction | Never invent per-step progress bars |
| Serial dependencies | Step pending on `dependsOn` | Pending steps render as pending, not failed | Dependency state from typed phases + task rows |
| Approval | Turn `awaiting_approval` | Approval card is the explicit waiting surface; card stays visible | Approval blocks stay actionable until resolved |
| Internal verification | Semantic gate or completion checks run | No user-facing state or prose | Private QA metadata cannot override persisted runtime facts |
| Failure | Turn `failed` / step failed (not cancelled) | Final assistant message reports the concrete delivery impact; the quiet Run details entry remains neutral | Step-level failure truth remains available in the Workbench; cancellation is NOT failure (#624/#626) |
| Cancellation | User stop; envelope `cancelled` | Successful work keeps its shape; unfinished work marked cancelled | `applyTerminalStatus` discriminates on successful work |
| Retry | New turn re-runs prompt / step retried | New turn owns new card; prior turn immutable | Regenerate clones prompt to new turn (#626) |
| Reconnect/reload | Restore from envelopes + timeline | Same render tree as live append (deterministic projection) | `(turnId, seq)` only; no client clocks |
| Legacy session | Rows without turn identity / prose plans | Frozen renderer; prose plan messages render as messages | No migration, no reinterpretation |
| Completed with deliverables | Terminal turn + artifacts | MOZI answer → primary/inline artifacts → memory receipt → quiet Run details entry | Role contract above |

Rules that hold across every row:

- Terminal truth comes from the Turn Envelope, never from visual adjacency or
  tool counts.
- A block/card containing successful work is never visually rewritten to
  "cancelled" wholesale (#626).
- Exactly one surface owns an active turn's execution state at a time.
- Screen readers get one meaningful live status change per transition, not
  every low-level event.

## Presentation Matrix (normative — every runtime signal, one place)

Added 2026-07-18 after repeated point-fixes. This table is the single spec for
what renders where, its default disclosure state, and who owns the live
indicator. UI changes that contradict a row must change this table in the same
PR, or they are wrong.

| Runtime signal | Where it renders | Live (turn active) | Terminal (turn done) | Default state |
|---|---|---|---|---|
| Turn without typed plan — activity | One compact chat capsule plus the right Run Workbench | The capsule is the only live chat element; click opens the Workbench | Quiet `Run details` summary after MOZI's answer | Capsule never expands inline |
| Turn with typed plan | One consolidated chat capsule linked to the foreground/background logical run | Capsule shows current action, progress and motion; click opens the Workbench | Quiet `Run details` summary after MOZI's answer and outputs | Capsule never expands inline |
| Plan phases | Workbench **Plan** tab as one DAG/list representation | Running nodes use the active work token and spinner | Frozen terminal state | Visible on Plan tab |
| Tool calls (web) | Workbench **Trace** tab; sources open on demand | Trace accumulates without creating chat rows | Same, frozen | Trace tab owns chronological work |
| Tool calls (local: read/write/run/inspect) | Workbench **Trace** tab with user-safe action labels | Same | Same | Raw args remain internal; no chat expansion |
| Interim narration (assistant prose mid-turn) | MOZI answer track only when it is genuine user-directed prose | Visible | Remains part of the answer | Never repurposed as process UI |
| Raw tool names / params / ms / errors | Internal logs only | Not shown | Not shown | Never user-facing |
| Deliverable (primary role) | MOZI answer track + Workbench **Outputs** tab/preview | Appears when persisted | Same | Visible and clickable |
| Supporting files | Workbench **Outputs** tab | — | Same | Output index owns them |
| Survived errors (source unreachable etc.) | Internal Trace data only when recovery succeeds | No warning in chat | No failed product status | Attempt failure is not run failure |
| Hard failure / cancel / interrupt / approval | Typed run truth plus the specific actionable surface | Visible when action is required | MOZI reports the concrete delivery impact; Workbench retains terminal state | Approval remains actionable; no generic verification warning |
| Interrupted turn re-started under the same turn id | Envelope returns to `active` (ended_at cleared) on any `startTurnEnvelope` re-run of an `interrupted` id — today only the durable plan runner reuses ids; any future id-reusing caller inherits this. `completed`/`failed`/`cancelled` are never resurrected | Live capsule again | — | G批-C, 2026-07-18: envelope sat at `interrupted` while resumed rows kept arriving |
| Plan verification result (semantic gate) | Internal metadata and logs only | — | Never user-facing | It cannot create a failed chat status, issue card, Trace row, or completion warning |
| Plan completion prose | Grounded in persisted step results and deliverables; never receives verifier verdicts, findings, evidence IDs, gate state, or internal paths. A provider-truncated summary is discarded for the bounded runtime-truth template — half-sentences never ship | — | — | Runtime facts own delivery; private QA remains private |
| Duration, reasoning passes, tool calls, output counts | Workbench **Overview** only | May update while active | Frozen at terminal state | Never repeated in chat copy |

Anti-flicker invariant: a live surface is keyed to the TURN, not to projection
blocks — narration splitting a turn into blocks must never unmount/remount the
live surface or leave dead vertical gaps.

Restore invariant (G批-A, 2026-07-18): the timeline history page must never
slice a turn's structural rows. Every turn with any row inside the page window
gets its `plan_started`, `task_update`, `artifact`, and `approval_request`
rows included even when they fall before the window (artifact rows keep their
FIRST timestamp across patches, so hero cards anchor early too — MEDIUM-3), so
a reloaded page projects the same plan/hero/approval cards as the live path —
no card may depend on live WS traffic to "self-heal". Each of these types is
bounded per turn (rows upsert by event_key); only the tool_event flood stays
paginated. Clients dedupe re-served rows by eventId.

### Artifact classes (2026-07-18, PR #746)

| Artifact class | Determination | Conversation | Workbench |
|---|---|---|---|
| Primary deliverable | file the plan/gate verified, or a foreground-authored document | Hero card | ✓ |
| Supporting file | co-produced beside the primary in the same turn | Collapsed group | ✓ |
| Inline visualization | completed svg (≤120K) or html/js FRAGMENT (≤30K, no `<!doctype>`/`<html>` shell) authored as the answer (not workspace, not a file) | Rendered INLINE — no-network-CSP sandboxed card whose frame adopts the graphic's own aspect ratio (clamped 220–460px at full card width, PR #748); title and ⋯ menu open the workbench | ✓ |
| Standalone HTML page | html code beginning `<!doctype>`/`<html>` — a page is read, not glanced | Click-to-open artifact card (never squeezed into the inline frame) | ✓ |
| Workspace working note | any detached-plan step authored artifact — document AND sandpack page (`role: 'workspace'`, G2). At completion the LAST completed workspace artifact is promoted to `primary` iff the turn has no other visible deliverable | NEVER a chat row; reachable via 查看全部产物 (N) under the deliverable | ✓ (sole home) |
| Downloaded data file (xlsx/csv the turn fetched as input) | When the turn authored a completed SANDPACK page, only deck/document files keep `primary` eligibility; sheets/archives/images become supporting. Enforced live within a step's tracker AND turn-wide at plan completion (per-step trackers cannot see each other's files — the completion backstop demotes in the DB before promotion runs). A `document_v1` alone does NOT strip a sheet's eligibility: doc+xlsx is a legitimate co-deliverable (G2) | Collapsed group, never the hero | ✓ |
| Mermaid fence in prose | ```mermaid in any markdown | Inline diagram (lazy chunk, bounded, raw-source fallback) | — |
| Artifact render truth (2026-07-19) | For a COMPLETED code artifact carrying `data.persisted_path`, the workbench renders the PERSISTED FILE's current content; the timeline `data.code` snapshot is only the live-streaming copy and the unreachable-file fallback. The runtime legitimately lets the model keep working on the persisted file after `create_artifact` (e.g. shell-injecting processed data) — gates verify the disk file, so the render must read the same truth (real incident: a placeholder template rendered as five empty charts while the disk file was complete) | Workbench = disk truth | ✓ |
