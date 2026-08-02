---
name: design-impeccable
description: "Always-on visual quality gate and progressive skill router for HTML, dashboards, charts, decks, documents, UI mockups, and other styled artifacts. It keeps universal anti-template rules in context and tells MOZI which specialist design skill to activate before planning visual work."
license: "Proprietary (rules adapted from Impeccable, Apache-2.0)"
version: "1.2.0"
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

# Visual Quality Gate

Keep this gate cheap. It routes visual work to the existing specialist Skills; it is not a
second full design handbook.

## Progressive routing

Before planning or creating visual output, activate only the smallest applicable set:

- Web UI, HTML, React, SVG, dashboards, charts, or visual reports: `frontend-design`.
- Complex multi-component web artifacts: `frontend-design`, then `web-artifacts-builder`.
- PPTX, DOCX, PDF, or spreadsheet deliverables: activate the matching format Skill; add
  `frontend-design` only when visual composition is material to the request.
- Posters and static art: `canvas-design`. Generative art: `algorithmic-art`.
- Restyling an existing artifact with a chosen theme: `theme-factory`.
- Anthropic brand styling: `brand-guidelines`, only when Anthropic branding is requested.

Load at most two Skills initially. Activate another only when the selected procedure calls
for it. Do not load every visual Skill “for safety.”

## Universal floor

- Establish subject, audience, and the artifact's single job before choosing a look.
- Pick structure before surface styling. Do not default to a hero followed by equal cards.
- Use only real supplied or computed content; never invent metrics, quotes, logos, or proof.
- Define a small token system and use it consistently; do not improvise colors or fonts midway.
- Make hierarchy, comparison, and reading order obvious before adding decoration.
- No emoji, purple-blue/neon gradients, decorative glow/blur, bounce motion, nested cards,
  oversized pills, fake browser/device chrome, or decoration that competes with the content.
- Preserve accessible contrast, keyboard focus, reduced motion, and narrow-screen layout.

Before returning, critique hierarchy, specificity, restraint, and structural originality.
Revise any dimension that still looks like a generic generated template.

The user's brand or design system overrides visual defaults. MOZI's own UI follows
`docs/DESIGN.md`; generated artifacts follow the activated specialist Skill.
