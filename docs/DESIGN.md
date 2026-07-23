# MOZI DESIGN.md — Binding Design Standard

> Adapted from the **Impeccable** methodology (github.com/pbakaus/impeccable, Apache-2.0):
> the anti-pattern discipline is vendored as *authored rules*, not as external code.
> This file is the single source of truth for MOZI's visual design — for **both**
> MOZI's own web UI (`ui/`) **and** the visual artifacts MOZI generates for users
> (HTML pages, decks, documents). If a design choice conflicts with this file,
> this file wins; change this file first.

## North Star

MOZI is a **personal Agent OS** — a calm, dense, professional operator surface, not a
consumer toy and not a generic "AI tool". The interface should feel **quiet, charcoal-dark,
and utilitarian**: information-dense without clutter, confident without decoration. The
product proof (chat, task runtime, artifacts, code) must always stay legible; the visual
system never competes with it.

## Design Tokens (source of truth: `ui/src/index.css`)

Never hardcode colors/radii in components — consume these variables.

**Dark theme — neutral charcoal, never pure black**
- Grounds: `--app-bg #181818`, `--main-bg #181818`, `--sidebar-bg #151515`
- Surfaces (elevation by background shift, not shadow): `--surface-base #181818` → `--surface-elevated #202020` → `--surface-input #20252c` → `--surface-hover #272d35` → `--surface-active #303741`
- Real overlays only: `--surface-overlay #202020dd` (Dialog/Popover); the light theme resolves it to opaque white
- Semantic color roles are independent: action = muted ochre, activity = jade,
  link = slate, inline code = warm sand, focus = bronze, selection = muted
  violet. Never route these roles through one global accent token.
- Status: `--success #7acb8b` · `--warning #e3b65a` · `--danger #e06c75` (danger = errors only, sparingly)
- Text (opacity layers on ink, not separate grays): primary .9 / secondary .7 / muted .46 / disabled .25
- Borders (hairline-first): `--border-subtle` (rgba .06) default, `--border-medium` (.1) active
- Radii (compact, sharply bounded): `--radius-card 8px` · `--radius-button 6px` · `--radius-badge 4px`
- Shadows: only the composer setback shadows; cards use border + background shift, **not** drop shadows

## Binding Rules (MOZI already respects most — keep it that way)

**DO**
- Consume tokens; add a new token to `index.css` rather than a one-off hex in a component.
- Elevate surfaces with background shift + a hairline border first; add shadow only when truly needed.
- Keep cards compact, flat, sharply bounded (8px), single-level — no card-in-card.
- Keep motion purposeful and short (fades, small translates, ≤200ms); ease-out, standard curves.
- Preserve legibility of product proof: chat, tables, code, task/artifact cards stay readable above all styling.
- Respect both `dark` and `light` themes via tokens. The product preference
  defaults to the operating system appearance.

**DO NOT (hard red lines — these are what "AI slop" looks like)**
- **No emoji in the UI.** (Pre-existing MOZI red line — absolute.)
- No purple→blue / neon gradients, no neon cyan fields, no glow as decoration.
- No glassmorphism / decorative `backdrop-blur` (translucency is allowed *only* for real overlays: modals, menus).
- No bounce/elastic/overshoot easing (`cubic-bezier` with values >1); no gratuitous motion.
- No pure black or pure white as a fill or ground — always tint toward the warm palette.
- No gray body text on colored backgrounds; use the ink-opacity text layers.
- No card-in-card nesting; no oversized rounded "pill" cards for dense content.
- No default/undistinctive typographic hierarchy — respect the size/weight scale, don't ship walls of same-size text.
- **No billboard empty states.** An empty list/section is the normal state, not an event: render one quiet muted line, never a large bordered box around blank space, and never wrap a plain form row in its own card.
- **No framed icon tiles.** An icon sits on a tinted fill or bare; a border around a small glyph reads as an empty frame. Card height is content-driven — no stretched slots that manufacture whitespace.
- **No redundant labeling.** Information already carried by a section header (category, grouping) is never repeated as a chip/footer inside every card under it.
- **Design-affecting changes are verified on real pixels** in the running app (multiple content lengths and panel widths), not only via unit tests.

## Execution Process Display (operator decision 2026-07-19)

The plan/timeline in chat is a runtime record, not a marketing checklist. Two
rules keep it reading as a system instead of a screenshot:

- **The expanded plan card is frameless.** No hairline border, no background
  shift — the "Plan" header, progress bar, and icon spine carry the structure,
  and the plan reads as part of the conversation. (Deliberate exception to the
  "background shift + hairline" card default; do not add the frame back.) The
  *collapsed* live capsule keeps a faint `bg-ink/[0.02]` lift only because it
  is a button and needs click affordance — still no hairline.
- **Success is quiet; color marks exceptions.** Completed steps use a bare
  muted-ink check (`text-ink/35` `Check`), never semantic green and never a
  circled badge — a column of green circle-checks is infographic language.
  Color is reserved for rows needing the operator's eye: running = accent,
  blocked/interrupted = warning.
- **Phase rows read at body size with the state written into the text**
  (2026-07-19, second pass): 15px rows — a plan is content, not
  instrumentation, and caption-size rows are what made the card read as a
  terminal. running = `font-medium ink/90`, done = struck through and
  receded (`ink/32 line-through`), pending = quiet `ink/45`. The list is
  the assistant crossing off its own to-dos, not a status console.
- **The terminal plan card has no in-card header.** No title, no
  done/total fraction — the row states carry it, and the turn fold already
  labels the section. A title + fraction + bar is a mini-dashboard embedded
  in prose. (The "Verifying" chip stays: a verifying card must not read as
  settled.) The LIVE capsule keeps its one-line header + accent bar — that
  is its collapsed summary job, and it leaves with the capsule.
- **No progress bar on the terminal card.** A colored rule under the header
  reads as a divider cutting the record off from the conversation. The
  done/total fraction and the row icons carry the state. Only the *live*
  capsule keeps a thin accent bar — it is the alive signal, and it leaves
  with the capsule when the turn ends.
- **Every completed step is disclosable.** A phase row opens to its tool
  rows AND its persisted result excerpt (`resultDetail`, server-carried) —
  a step that ran without tools must never render as a dead, unclickable
  row while the completion prose points users at the card for details.

## Chat Prose (the reading surface — operator decision 2026-07-18)

Final answers and Markdown documents use the MIT-licensed typography contract
from `@lobehub/ui@5.15.5`, transcribed into MOZI's existing ReactMarkdown
renderer so headings, path-safe links, anchors, table normalization and print
remain wired. The spec lives in `ui/src/components/chat/prose.ts`; process
narration keeps the deliberately subordinate `CHAT_PROSE_COMPACT_CLASS`.
Changing these values means amending this section in the same PR. Never style a
reading surface with Tailwind Typography (`prose prose-invert …`): the plugin is
not registered and those classes generate zero CSS.

- **Measure and continuity**: the conversation rail follows Lobe's 960px
  boundary with 16px inline padding. Assistant rows consume the full available
  rail; with MOZI's 26px avatar and 12px gap, final-answer prose receives about
  890px instead of the former ~722px. Compact process blocks and deliverable
  cards retain their own subordinate width caps, so widening the reading
  surface never inflates capsules. The active composer uses the same 960/16
  boundary. Markdown documents use a centered 960px reading measure with 16px
  canvas padding; this keeps a full-window Artifact dense without letting long
  lines or sparse tables drift across the entire pane.
- **Body**: final answer 14px / 1.6 (`variant="chat"`); Markdown document 15px /
  1.7 (default variant). Process narration stays 13px / 1.7. UI and capsule text
  do not inherit either reading scale.
- **Headings**: chat h1 19.25 / h2 17.5 / h3 15.75 / h4 14.875, with h5/h6 at
  14; document h1 30 / h2 24 / h3 20 / h4 17, with h5/h6 at 15. Document
  headings intentionally keep Lobe's weight and 1.25 line height while using a
  smaller full-pane scale than Lobe's split Portal default.
- **Rhythm**: chat uses Lobe's compact answer rhythm. Documents use 15px heading
  margins, .85em content-block spacing and 2.25em horizontal-rule spacing so a
  long report remains calm without reading like a presentation slide.
- **Lists**: chat restores native unordered markers, as Lobe's chat variant
  does; the document variant uses the base renderer's quiet dash marker.
- **Tables**: chat tables stay content-sized. Document tables fill the centered
  reading measure; both remain horizontally scrollable at narrow widths, with
  8px radius, minimum 120px cells and `.75em 1em` padding. Keep the actual
  `<table>` semantic and the dedicated overflow frame.
- **Anchors**: every Markdown heading receives a stable Unicode-safe id.
  Fragment links scroll inside their own reading surface and must never hand a
  `#fragment` to MOZI's hash router.
- **Ink layering**: headings 95/90, primary reading body 86, folded narration
  70. Markdown `strong` is 600; headings are Lobe's 700.
- **Process is one size down** (operator decision 2026-07-19): everything
  inside the 查看处理过程 fold is subordinate to the answer — narration uses
  `CHAT_PROSE_COMPACT_CLASS` (13px / 1.7) and plan to-do rows step down from
  body 15px to 13px in the embedded context. The LIVE plan capsule keeps
  body-size to-dos: while the turn runs it is the hero surface; once folded
  it is an appendix.
- **CJK fallback is explicit**: `"PingFang SC", "Hiragino Sans GB",
  "Microsoft YaHei"` after the latin stack — CJK glyph choice must never
  depend on the browser's default fallback.

## Known Deviations (tracked — fix deliberately, don't regress further)

These exist today; new code must not add more, and prefer the target when touching them:
1. **Light-theme `--action-fg: #ffffff` is pure white.** Target: tint (e.g.
   `#faf9f7`). Low urgency.
2. **All colors are hex; 0 OKLCH.** Impeccable prefers OKLCH for perceptual consistency. Migration is a nicety, not a blocker — new *brand* colors may be authored in OKLCH; do not mass-rewrite existing tokens without a design pass.
3. **Body font is `Inter, system-ui, …`** — flagged as "overused". A distinctive display face is a deliberate future brand decision; until then Inter stays (documented, not accidental). Do not silently switch fonts.
4. **3 `backdrop-blur` usages.** Audit each: keep only where it backs a real overlay; remove decorative blur.
5. **`--ink-rgb: 255 255 255` (dark theme) is pure white ink.** Same red line as #1 but for the entire text/border system — every `text-ink/*` in dark mode is a pure-white alpha. Target: warm-tint the base (e.g. `237 235 231`-family) in a dedicated pass with real-pixel review across all surfaces; do NOT change it casually — it recolors the whole app. Chat prose mitigates today via opacity layering (82/90/95), not by fixing the base.

## Applies To MOZI-Generated Artifacts Too

When MOZI generates an HTML page, deck, or document for a user, it must follow the same
DO/DO-NOT rules above (enforced at runtime via the `design-impeccable` skill). Uploaded/
generated deliverables are "product proof" — legible, restrained, no AI-slop tells.
