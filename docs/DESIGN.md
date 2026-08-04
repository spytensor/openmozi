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

These values describe what `ui/src/index.css` actually ships. They were
realigned on 2026-07-25 after an audit found the previous text describing a
warm-charcoal palette with independent muted hues that the product had not used
for a long time. If you change a token, change this section in the same commit —
a design doc that disagrees with the stylesheet is worse than none, because it
sends reviewers looking for violations that are actually the house style.

**Dark theme — true black ground, restrained state accents**
- Grounds: `--app-bg #000000`, `--main-bg #000000`, `--sidebar-bg #0a0a0a`
- Surfaces (elevation by background shift, not shadow): `--surface-base #000000` → `--surface-elevated #111111` → `--surface-card #161616` → `--surface-overlay #1a1a1a`; `--surface-input #111111`
- Interaction surfaces are ink alphas, not fixed greys: `--surface-hover rgba(255,255,255,.08)`, `--surface-active rgba(255,255,255,.12)`
- Light theme mirrors this structurally: `--app-bg #fafafa`, `--surface-elevated #ffffff`, `--surface-card #ffffff`
- General interaction roles remain monochrome: `--action`, `--activity`, and
  `--focus` are `#ffffff` in dark and `#000000` in light; `--link #a1a1aa`,
  `--selection rgba(255,255,255,.2)`. The one deliberate exception is
  `--work-active` (`#4f76e8` dark / `#315bc9` light), reserved for an agent that
  is actively executing. It must never become a general brand or navigation
  accent. The live title has its own presentation-only gradient tokens:
  `--work-title-start`, `--work-title-mid`, and `--work-title-end`; these never
  encode success, warning, failure, or verification state.
- Status colours are the only saturated hues and are reserved for state, never decoration: `--success #10b981` · `--warning #f59e0b` · `--danger #ef4444` (danger = errors only, sparingly)
- **Identity hues are a separate family** from status: `--agent-ochre #b08a4f`, `--agent-jade #6f9b74`, `--agent-slate #6d8299`, `--agent-bronze #a8674a`, `--agent-violet #9a7aa8`, `--agent-neutral #77808c`. They are low-saturation on purpose and render as a tinted fill with the glyph in the same hue — an identity must never restate a status colour, and a saturated block at avatar size competes with the content it labels.
- Text (opacity layers on ink, not separate greys): primary .9 / secondary .7 / muted .46 / disabled .25; the flat equivalents are `--text-primary #ededed` / `--text-secondary #a1a1aa` / `--text-muted #71717a` / `--text-disabled #3f3f46`
- Borders (hairline-first): `--border-subtle` (rgba .08) default, `--border-medium` (.15) active
- Radii: `--radius-card 12px` · `--radius-button 8px` · `--radius-badge 6px` ·
  `--radius-work 18px` (only the live-work capsule and its matching detail
  surface)
- Shadows: only the composer setback shadows; cards use border + background shift, **not** drop shadows

## Binding Rules (MOZI already respects most — keep it that way)

**DO**
- Consume tokens; add a new token to `index.css` rather than a one-off hex in a component.
- Elevate surfaces with background shift + a hairline border first; add shadow only when truly needed.
- Keep cards compact, flat, sharply bounded (`--radius-card`), single-level — no card-in-card.
- Keep motion purposeful and short (fades, small translates, ≤200ms); ease-out, standard curves.
- Preserve legibility of product proof: chat, tables, code, task/artifact cards stay readable above all styling.
- Respect both `dark` and `light` themes via tokens. The product preference
  defaults to the operating system appearance.

**DO NOT (hard red lines — these are what "AI slop" looks like)**
- **No emoji in the UI.** (Pre-existing MOZI red line — absolute.)
- No purple→blue / neon gradients, no neon cyan fields, no glow as decoration.
  The sole exception is the tokenized, text-only live-work title flow described
  below; it is an activity signal, never a page background or status colour.
- No glassmorphism / decorative `backdrop-blur` (translucency is allowed *only* for real overlays: modals, menus).
- No bounce/elastic/overshoot easing (`cubic-bezier` with values >1); no gratuitous motion.
- No unmotivated mid-greys or muddy tints. The ground is true black (dark) / near-white (light) by design; depth comes from the surface ladder and hairline borders, not from washing the background.
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

- **Live and terminal work have different owners.** While a turn is active,
  chat owns one compact live capsule derived from runtime events. The capsule
  never expands in chat; clicking anywhere on it opens the right Workbench.
  Every envelope-backed turn uses this ownership model; a terminal
  `RunOutcome` enriches its final truth. Chat keeps only the answer, output
  links, and a quiet run summary; the right Workbench becomes the sole owner of
  Overview, Plan/DAG, Reasoning summary, Trace, and Outputs. Never duplicate a
  terminal run as an inline `View work` fold. Rows without a Turn Envelope use
  the frozen legacy renderer and never compete with the Workbench path.
- **One logical run is one MOZI-authored track.** The first visible MOZI row
  claims the avatar; its live capsule, approval, final answer, primary/inline
  artifacts, memory receipt, and terminal summary stay on that same assistant
  axis without restarting identity. Concurrent logical runs claim independent
  avatars. The authored terminal order is answer → primary/inline artifacts →
  memory receipt → quiet run summary; Run Trace retains the original event
  chronology.
- **The Workbench is one region with a navigation stack.** Run inspection and
  rendered artifacts replace each other in the same right region. Opening an
  output from a run pushes the artifact preview and provides Back; it never
  opens a competing panel, modal, or page takeover.
- **The live capsule is visibly alive.** Running work uses the restrained
  `--work-active` border plus a shallow state tint, spinner, elapsed time, and
  progress line. It has one border — no outline, glow, or drop shadow. Terminal
  work recedes to the quiet Run details entry; its plan remains in the
  Workbench rather than expanding in chat.
- **The live title names the current action.** “Working” / “正在处理” is helper
  text and a last-resort fallback, never the primary title while runtime truth
  can name the action. The title alone uses a restrained left-to-right
  white/lavender/cobalt text flow that is identical across runtime states;
  reduced-motion keeps the same gradient still. Transport identifiers such as
  `process_id` and UUIDs remain technical detail and never become titles.
- **Internal QA never becomes product status.** Tool retries, provider
  recovery, semantic verification, completion gates, and `RunOutcome` issue
  metadata stay out of chat, the run summary, Overview, Plan, Reasoning, Trace,
  and completion prose. The terminal chat affordance is always the same quiet
  “Run details” link. A real need for user input or permission uses its own
  actionable surface; recovered attempts and verifier diagnostics remain
  internal logs and metadata.
- **State color stays semantic and restrained.** Running uses the cobalt work
  token with a spinner; completed uses a quiet success check; pending is
  neutral; blocked is warning; failed is danger. Icons remain bare rather than
  becoming circled badges.
- **Plan state belongs to the Workbench Plan tab.** DAG/list nodes use body-size
  labels and typed states: running uses the active work token plus spinner,
  completed uses a quiet success check, pending recedes, and blocked uses the
  warning token. Chat never renders a second terminal plan card, fraction, bar,
  phase list, or verifier chip.
- **Trace owns chronology; Plan owns dependency shape.** A plan node may select
  the corresponding run context in the Workbench, but it never expands tool
  calls or result excerpts inline. Tool rows and persisted execution details
  remain in Trace; deliverables remain in Outputs.
- **Workbench motion communicates active state only.** Layout and selection
  transitions use a restrained 180–200ms ease-out and collapse to no motion
  under `prefers-reduced-motion`. Finished nodes do not pulse or keep an active
  progress indicator.

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
- **User Markdown is compact and inert.** User bubbles render the submitted GFM
  source directly (headings, lists/checklists, tables, blockquotes, safe links,
  inline and fenced code) without assistant normalization. Raw HTML never runs;
  remote images become text placeholders, unsafe/local links stay plain, and
  Mermaid remains fenced code. Copy and regenerate use the same visible,
  context-cleaned source that the bubble renders.

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
