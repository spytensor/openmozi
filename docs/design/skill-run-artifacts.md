# Design — Skill-Run Visibility & Output Artifacts

- Status: Design (backend first, then frontend)
- Motivation: a PPT-building turn ran a skill and produced a `.pptx`, but
  the UI showed only "完成 N 步" pills — no skill attribution and, worse,
  **the produced file was invisible and undownloadable.** Users are lost.

## Two gaps

1. **Output files don't surface.** Office skills write files via a python
   script through `shell_exec` into `~/.mozi/output`. That path produces
   no artifact event (only `write_file` html/svg and `create_artifact`
   do). The deliverable vanishes.
2. **Skill use isn't visible at a glance.** The `❖ Enable skill` row
   exists only inside the *expanded* timeline. At rest the user sees
   nothing about which skill drove the work.

## Part A — Output artifacts (backend, robust, model-independent)

**Mechanism: watch the output roots during a turn; surface new/modified
deliverable files as file-artifacts.** Model-independent (does not rely on
the model remembering to "register" its output — DeepSeek won't).

- During an active turn, watch `~/.mozi/output` (+ the active project
  granted root, if any) for files created/modified within the turn window.
- Emit an `artifact_open` (reuse the existing artifact pipeline) with a new
  **file artifact** shape: `{ plugin_id: 'file_v1', title: <filename>,
  data: { path, filename, ext, size, mime, kind } }`. `kind` from ext:
  document (docx/pdf/md), sheet (xlsx/csv), deck (pptx), image
  (png/jpg/svg), archive (zip), code (…), other.
- **Filter to deliverables, drop scaffolding:** never surface the `.py`
  build script itself or dotfiles/tmp. Allowlist by extension; collapse
  multiple writes to the same file into one artifact (latest wins).
- **Attribution:** if a skill is active in the turn (a `use_skill` ran),
  tag the file artifact with `skillName` so the UI can say "produced by
  pptx".
- Honesty: only surface files that were actually written (real mtime/size).
  No placeholder "your file is ready" before it exists.

**File serving:** add `GET /api/fs/file?path=…` — auth-gated, path must be
inside the effective allowed roots (reuse workspace-policy), streams the
file with correct content-type + content-disposition. This is what the
artifact card's download button hits. Refuse paths outside roots (same
policy as fs tools).

**Preview (later, optional):** pdf/png can preview in the artifact panel;
docx/xlsx/pptx show a file card with icon + size + Download (+ "Reveal in
Finder" only in the native/Electron shell). No fake in-browser Office
render.

## Part B — Skill-run visibility (frontend)

- **Turn-level skill badge:** when a turn involved `use_skill`, show a
  small `✦ {skill}` chip on the answer/turn header (not buried in the
  expanded timeline). Multiple skills → chips. Reuses `skillName` already
  on tool events.
- **Output artifact card:** the file-artifact renders as a compact
  downloadable card in the timeline (reuse the artifact card work): type
  icon (from Part A `kind`, reuse the 8 type icons), filename, size, a
  Download button hitting `/api/fs/file`, and a `✦ {skill}` provenance
  line when attributed. Clicking a previewable type opens the panel.
- **Empty-hands guard:** if a turn clearly tried to produce a file but
  none appeared (script errored), the timeline already shows the failed
  step — do not fabricate a success card.

## Sequencing

1. **BE-1** file-artifact emission (output-dir watch + `file_v1` shape +
   skill attribution + dedupe/allowlist). Tests: writing a pptx into
   output during a turn emits one file artifact; the .py script does not;
   overwrite collapses to one.
2. **BE-2** `GET /api/fs/file` streaming endpoint (auth + roots + mime +
   disposition). Tests: serves an allowed file; 404/refuse outside roots.
3. **FE-1** file-artifact card (icon/size/download) + skill provenance.
4. **FE-2** turn-level skill badge.

BE-1/BE-2 are the gating, testable backend. FE follows the event shape.
Independent of the sandbox track.
