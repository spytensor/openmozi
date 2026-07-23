---
name: design-impeccable
description: "Use this skill WHENEVER you generate anything visual for the user — an HTML page, a slide deck, a dashboard, a chart, a styled document, a landing page, a UI mockup, or any create_artifact with visual/frontend output. It encodes MOZI's binding design standard (adapted from the Impeccable methodology) so generated deliverables look professionally crafted, not like generic 'AI slop'. Load it before writing HTML/CSS/JSX or styling a document, and apply its DO/DO-NOT rules to the output."
license: "Proprietary (rules adapted from Impeccable, Apache-2.0)"
version: "1.1.0"
category: system
user-invocable: false
# Always-on: the design red lines must be in context whenever the Brain might
# emit visual output (HTML/deck/document/chart), which can happen on any turn.
# Kept concise to bound the per-turn token cost.
always: true
requires:
  bins: []
  env: []
---

# Impeccable Design Standard (for anything MOZI renders visually)

Full standard: `docs/DESIGN.md` + `docs/PRODUCT.md`. This skill is the runtime digest the
Brain applies while GENERATING visual output for the user. The deliverable should look like
a competent human designer made it — restrained, legible, professional.

## Register (from PRODUCT.md)
Calm, precise, professional. Dense but legible. No hype, no emoji, no delight-for-its-own-sake.
The content (the user's actual data/argument) is the star; styling serves comprehension.

## DO
- Pick a small, deliberate palette: one warm-neutral ground, one accent, tinted text layers.
  Prefer OKLCH; never use pure `#000`/`#fff` — always tint slightly.
- Establish real typographic hierarchy: a clear size/weight scale, generous line-height
  (1.5–1.8 for body), 60–75ch max line length. Use one quality typeface well.
- Elevate with a 1px hairline border + subtle background shift before reaching for shadow.
- Keep cards compact, flat, single-level, sharply bounded (small radius). Consistent spacing rhythm.
- Use color with intent (state, emphasis) — mostly restrained, accent used sparingly.
- Motion (if any): short, ease-out, purposeful. Ensure WCAG-AA contrast and real touch targets.

## Color direction (choose, don't default)
The most common slop tell AFTER gradients is the default palette: a safe blue/indigo
accent (OKLCH hue ~230–290) on white/beige — the same look as every other generated
report. Never reach for blue first; choose the accent, don't inherit it.

- Derive the accent hue from the subject matter and commit to it: automotive/industrial
  → oxide red or steel; finance/markets → deep green or ink; energy/climate → moss or
  amber; culture/editorial → oxblood, ochre, or slate; health → clay or teal.
- One accent, fully committed: section markers, key numbers, links, and the primary
  chart series all share it. Supporting tints are lightness/chroma variants of the SAME
  hue — never a second decorative hue.
- Chart series: an analogous ramp built around the accent (accent ± neighboring hues,
  varied lightness), not five unrelated hues. A rainbow legend is a template tell.
- Ground: decide light or dark deliberately — warm paper (oklch ~0.97, hue 70–90) for
  documents/reports, deep ink (oklch ~0.20–0.25) for dashboards. Tint it toward the
  accent's temperature so ground and accent feel related.
- The numbers that carry the argument get the accent at full strength; everything else
  stays in the neutral text layers.

## DO NOT (the "AI slop" tells — never ship these)
- No emoji in the output. That includes flag emoji for countries — they violate the
  emoji rule AND are frequently the wrong country when composed from codepoints; use
  text names/codes or a neutral marker instead.
- No purple→blue or neon gradients, no neon cyan, no glow-as-decoration.
- No glassmorphism / decorative blur (translucency only for genuine overlays).
- No bounce/elastic/overshoot easing; no gratuitous animation.
- No pure black or pure white; no gray text on colored backgrounds.
- No wrapping everything in cards; no card-in-card nesting; no oversized rounded pill-cards.
- No default undistinctive font stack (Arial / bare system-ui) for a deliverable that represents the user.
- Don't let decoration bury the content: tables, numbers, code, and arguments must stay legible.

## Self-check before returning visual output
1. Would this look hand-crafted, or like a template generator filled in blanks?
2. Any pure #000/#fff, neon/gradient, glass, bounce, emoji, nested cards? → fix.
3. Is the hierarchy real (a reader's eye knows where to go) and is contrast AA?
4. Is the content more prominent than the chrome?
5. Is the accent a blue-by-default? If you can't say why THIS hue fits THIS subject, pick again.
6. Do the headline/hero numbers recompute from the document's own body data? A summary
   metric that contradicts its own table is worse than no metric.

When the user's own brand/DESIGN.md exists, that overrides these defaults — but the DO-NOT
red lines always hold.
