# Design — Unified Artifact Lifecycle Coordinator

- Status: Design → implementation (Codex)
- Motivation: one logical deliverable ("make a deck") renders as 2–3 cards
  (stuck "Generating", write_file card, create_artifact card). Repeated dedup
  patches don't fix it because there is **no single owner of artifact
  identity or state.**

## Root cause (from the lifecycle audit)

Six independent id-minting sites, none coordinated:

| Path | id source | converges? |
|------|-----------|-----------|
| live preview (streaming) | `createArtifactId('live')` | via flaky title match |
| pre-open (parsed args) | hint OR new | title match |
| create_artifact tool | hint OR new | if hint found |
| write_file → artifact | hint OR new | if hint found |
| file_v1 output scan | always new | **never** (no hint awareness) |

Convergence relies on **title matching**, which fails while the title is still
streaming → the live id never reaches the final → two+ cards. Terminalization
was error-path only (now also a success sweep — a stopgap).

## Target architecture

**A single `ArtifactCoordinator`, one per turn, keyed by `toolCallId`.** Every
emission path goes through it; nothing calls `onArtifact` directly.

`toolCallId` is the reliable convergence key: the streaming input delta, the
pre-open from parsed args, and the final tool result ALL carry the same
`toolCallId`. Identity derives from it, not from titles.

### Contract

```
class ArtifactCoordinator {
  constructor(turnId, emit /* the real onArtifact */)
  // Returns the canonical artifact id for this toolCallId, opening once.
  openOrGet(toolCallId, seed: { plugin_id, title, content_type, ... }): artifactId
  // Patch by toolCallId (preferred) — resolves to the canonical id.
  patch(toolCallId, patch): void
  complete(toolCallId, finalPatch): void      // marks terminal
  // Files produced on disk: converge by path to the toolCallId that wrote them.
  registerFileWrite(toolCallId, absPath): void
  resolveByPath(absPath): artifactId | null   // for the output scan
  terminateAll(status): void                  // idempotent; called on EVERY turn exit
}
```

Rules:
1. **One toolCallId → one artifactId, forever.** open is idempotent; a second
   open for the same toolCallId returns the existing id (and may patch the
   seed, e.g. plugin_id reclassification live_work_v1 → sandpack_v1).
2. **All sites route through the coordinator.** live tracker, pre-open,
   create_artifact, write_file, and the file_v1 scan. No direct onArtifact.
3. **file_v1 converges by path.** write_file calls registerFileWrite(toolCallId,
   path). The output scan calls resolveByPath first; if it resolves, it patches
   that artifact (or skips, if already a rich artifact) instead of minting a new
   file card. Genuine standalone binaries (pptx/xlsx not tied to a toolCall)
   still get their own file_v1 — but only once.
4. **Guaranteed terminalization.** terminateAll(status) runs in the turn's
   finally on all exits; idempotent (skips already-terminal). No card can stay
   "Generating" forever.
5. **No title-based convergence.** Titles are display only; identity is
   toolCallId/path.

### Migration (route the 6 sites, delete the flaky matching)

- Replace `artifactHints` title-matching (`findCompatiblePreopenedArtifactHint`)
  with `coordinator.openOrGet(toolCallId, …)`.
- Live tracker (brain-engine ~604): `openOrGet(toolCallId, {plugin_id:'live_work_v1'})`.
- Pre-open (~1235), create_artifact (runtime-tools ~418), write_file
  (fs-tools ~232): all `openOrGet(toolCallId, …)` + `complete(toolCallId, …)`.
- file-artifacts scan: `resolveByPath` before emitting; register writes from
  write_file.
- Replace `failRunningArtifacts` / `closeRunningArtifactsOnSuccess` with
  `coordinator.terminateAll('failed' | 'completed'|'closed')` in the finally.

## Acceptance

- One "make a deck" turn (live stream → write_file OR create_artifact) yields
  **exactly one artifact card**, id stable open→complete, never stuck.
- A turn that writes a real .pptx yields one file card, previewable.
- No card left "running" after the turn under any exit path.
- UI unchanged (it already dedups by id correctly once ids match).

Keep the interim stopgaps (f8c8cdf) until this lands; then remove the
now-redundant success-sweep in favor of the coordinator's terminateAll.
