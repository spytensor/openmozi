# Chat Presentation Contract (Issue #735)

Status: PR 1 of the #735 epic. This document freezes the render contract the
Working Card (PR 2) and sticky capsule (PR 3) build on. The durable event log
and the deterministic turn projection (#623/#625/#626/#628) are unchanged; this
contract only adds typed presentation semantics on top of them.

## Principles

1. **Runtime truth, typed.** Presentation structure (a plan's phases, a
   deliverable's role) travels as typed event/data fields, never as formatted
   prose persisted into assistant messages. Prose freezes layout decisions into
   runtime truth; typed data lets every surface render the same source.
2. **One source per fact.** The inline card, sticky capsule, Inspector, and
   chat blocks must consume the same projection. No surface re-derives task
   truth from frontend heuristics (tool counts, visual adjacency, regex over
   prose).
3. **Legacy is renderable, never rewritten.** Historical sessions keep their
   prose plan messages and role-less artifacts; new typed events are additive
   and capability-gated. No destructive migration.

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
| Verifying | Verification steps running (semantic gate, checks) | Card state "Verifying", not "Done" | Verification warnings must not hide behind success |
| Failure | Turn `failed` / step failed (not cancelled) | Final assistant message reports the failure; the collapsed card uses the neutral process entry | Step-level failure truth remains visible when expanded; cancellation is NOT failure (#624/#626) |
| Cancellation | User stop; envelope `cancelled` | Successful work keeps its shape; unfinished work marked cancelled | `applyTerminalStatus` discriminates on successful work |
| Retry | New turn re-runs prompt / step retried | New turn owns new card; prior turn immutable | Regenerate clones prompt to new turn (#626) |
| Reconnect/reload | Restore from envelopes + timeline | Same render tree as live append (deterministic projection) | `(turnId, seq)` only; no client clocks |
| Legacy session | Rows without turn identity / prose plans | Frozen renderer; prose plan messages render as messages | No migration, no reinterpretation |
| Completed with deliverables | Terminal turn + artifacts | Primary artifact leads; supporting group collapsed; card becomes quiet receipt | Role contract above |

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
| Turn without typed plan — activity | Same collapsed working capsule as plan turns (minus phases/progress bar) once ANY execution activity exists; bare one-line status only before the first observable event | The ONLY live element — click expands the process rows; the turn's streaming artifacts stay behind it, never parade above | Absorbed into the turn fold | Capsule collapsed; fold collapsed (2026-07-18: the working region is not plan-only) |
| Turn with typed plan | ONE consolidated plan capsule at the turn's tail (stable mount; plan on the foreground turn links to `turn_bg_<planId>` execution) | The ONLY live element — a COLLAPSED capsule (plan title, progress fraction, current action, thin bar); click expands the phase spine | Plan card inside the turn fold, phase spine first | Capsule collapsed while live; fold collapsed after (2026-07-18 operator decision) |
| Plan phases | Parent rows inside the expanded plan card | State ring icons (done ✓-ring / running spinner / queued hollow) | Same, frozen | Visible once the capsule/card is expanded |
| Tool calls (web) | Narrative rows nested under their phase; adjacent same-kind fold to "Searched N sources"/"Browsed N pages" + favicon stack | Rows accumulate behind their OWN phase row — the phase row is the toggle; expanding one phase never expands the others (2026-07-18) | Same | Hidden until that phase is clicked; sources open on demand |
| Tool calls (local: read/write/run/inspect) | Verb rows (filename target where extractable); identical adjacent rows collapse to ×N | Rows accumulate behind their own phase row (plan turns); visible as rows on plan-less turns | Same | Plan turns: behind the owning phase row. Plan-less turns: visible rows. Raw args only in Technical details |
| Interim narration (assistant prose mid-turn) | In place, chronological | Visible | Folded into the turn fold | Folded after answer |
| Raw tool names / params / ms / errors | Technical details appendix — exactly ONE per turn | Not shown | At the fold's tail | Collapsed |
| Deliverable (primary role) | Hero card in chat + workbench preview | Pre-opened live artifact if streaming | Hero card above the closing prose | Visible |
| Supporting files | One collapsed group behind the deliverable | — | Same | Collapsed |
| Survived errors (source unreachable etc.) | One quiet amber line in the narrative | Visible | Kept inside fold | Visible, never hidden |
| Hard failure / cancel / interrupt / approval | Own surface, never folded | Visible | Visible | Hard-failure process entry stays collapsed and neutral; cancel/interruption retain explicit labels; expanded step rows retain their truth. Approval stays actionable (2026-07-22) |
| Interrupted turn re-started under the same turn id | Envelope returns to `active` (ended_at cleared) on any `startTurnEnvelope` re-run of an `interrupted` id — today only the durable plan runner reuses ids; any future id-reusing caller inherits this. `completed`/`failed`/`cancelled` are never resurrected | Live capsule again | — | G批-C, 2026-07-18: envelope sat at `interrupted` while resumed rows kept arriving |
| Plan verification failure (semantic gate) | Its own failed task row on the background turn — "Result verification" with the finding as row detail (`rawStatus: plan_verification_failed`) | — | Visible inside the plan card | Visible when the card is open; the reason must never be only in completion prose |
| Plan completion prose | Verification-failed-first is a PROMPT policy (G4), not runtime-verified — the durable truth surface is the verification task row above. Runtime-enforced: a Brain summary the provider cut off (stop_reason length/max_tokens/content_filter, or an incomplete stream) is discarded for the bounded runtime-truth template — half-sentences never ship (G3) | — | — | 2026-07-18: "All five steps completed …" delivered over a failed freshness gate, cut at "**Key findings from completed" |
| Step counts, tool counts | NEVER user-facing copy (only the plan card's phase done/total) | — | — | — |

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
