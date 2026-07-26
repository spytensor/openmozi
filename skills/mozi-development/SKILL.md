---
name: mozi-development
description: Read before changing MOZI itself — how the runtime is actually built, what already exists to reuse, and how to prove a change is wired before calling it done.
version: 1.0.0
license: MIT
category: system
user-invocable: true
metadata:
  priority: 20
---

# Working on MOZI

Load this before adding or changing anything in this codebase. Its job is to
stop you rediscovering the architecture by grep every time — and, more
importantly, to stop you drawing the **wrong** map, which is the failure this
codebase keeps repeating.

The companion artifact is `docs/atlas/MOZI-架构全景.html` — a module-by-module
map of this runtime: design, implementation, third-party vs custom, call paths,
**wiring verdicts backed by non-test callers**, examples and known traps. Read
the section for the layer you are touching before designing anything. Its code
excerpts are extracted from the tree by anchor, not transcribed, so they cannot
silently drift.

When you finish a change, run `python3 docs/atlas/staleness.py`. It reports
which atlas modules your diff invalidated — usually a handful — so the map is
updated by targeted rescans rather than by repeating the full sweep, which is
what let the previous atlas rot 151 commits behind. If it reports files that
belong to no module, you have either added a subsystem the map does not know
about or found a coverage gap; either way it needs an entry.

## Why a scan of the code lies to you

Three failure modes, all with real incidents behind them. Assume all three are
present until you have checked.

1. **Code exists, nothing calls it.** Vector memory sat installed and dead for
   four months. `memory_summaries` had a UI reading a table nothing wrote. The
   whole telemetry pipeline had dashboards and replay tooling while its three
   writers had zero callers. A grep that finds a function proves nothing about
   whether it runs.
2. **Documentation describes intent, not behaviour.** Files claim capabilities
   the runtime never registered. `docs/` and `CLAUDE.md` have both been wrong
   about live call paths. Trust the call graph over any prose, including this
   file.
3. **A second implementation quietly wins.** Two build-script allowlists existed;
   only one was read, so a dependency's install step never ran and the conflict
   also swallowed the warning. When behaviour contradicts configuration, look
   for the other implementation before concluding the config is broken.

## Before you design: find what already exists

Ask these in order. Most "new" features in this codebase are a new entry in an
existing registry, not new machinery.

- **Is it a tool the model can call?** Tools are declared centrally and gated by
  runtime predicates — adding one is a definition plus an executor branch plus a
  permission entry, not a new subsystem.
- **Is it a capability the model should reach for by name?** That is a
  `SKILL.md`, discovered from disk. No code change at all.
- **Is it a persona that should run isolated with its own tools?** That is an
  `AGENT.md`, and the delegation path already exists.
- **Is it a new LLM vendor?** The provider catalog is data. Check whether the
  existing `openai-compat` mode can express it (custom headers and query
  params are supported) before adding an API mode or a dependency.
- **Is it a new chat surface?** Channels are registry plugins; the gateway does
  not change.
- **Is it long-running work?** There is already a background job runner with a
  handler registry, and a managed-worker contract for external CLI agents.
- **Does it need to survive a restart?** There is a durable job state machine
  and an event log. Do not invent a second one.

If the answer to all of these is no, say so explicitly in your plan and explain
why the existing seams do not fit. That sentence is where over-engineering gets
caught.

## While you build

- **Match the layer's existing idiom.** Every layer here has one — registry
  plugins, Zod-validated envelopes, slot-based prompt assembly. A change that
  invents its own idiom is harder to review and usually means the seam was
  missed.
- **Everything crossing a process or network boundary needs a timeout and a
  cancellation path**, and the cancellation must chain to the parent turn.
  Cancellation has been broken twice by a child creating its own signal instead
  of linking the caller's.
- **Validate external data at the boundary** with the schema layer already in
  use; do not hand-parse.
- **Do not widen permissions implicitly.** A declared permission level is a
  ceiling, not a request — clamp against the caller's level.
- **Anything published outward has its own procedure.** See the public-release
  skill; do not improvise.

## Before you call it done: prove the wiring

A feature is not finished when its tests pass. Unit tests call the function
directly, so they pass for dead code — that is exactly how the incidents above
survived review.

- [ ] **The write side has a live caller.** Every new export must be reachable
      from a production entry point: a turn, a channel message, a scheduled
      job, an API route, or a CLI command. Name that caller.
- [ ] **The read side reads something that is actually written.** If you added
      a panel, an API, or a prompt slot, name the writer.
- [ ] **You ran the real path once** and observed the effect — a row appearing,
      an event firing, the UI changing. If the environment made that
      impossible, write "wiring unverified at runtime" rather than implying it
      works.
- [ ] **Tests exist for the new behaviour**, and you ran them.
- [ ] **UI changes were checked on real pixels** in the running app, not only in
      unit tests. Feature flags and unmounted views have hidden finished work
      more than once.
- [ ] **You did not leave a second implementation behind.** If you replaced
      something, delete the old path or say why it stays.

## When a check fails

Diagnose before patching. Two habits, both learned expensively:

- **A failure may be the environment, not the change.** A stale dependency tree
  invented type errors that did not exist in the code. A leaked `NODE_ENV`
  turned every UI test red. Before editing source to satisfy a failing check,
  confirm the check fails for the reason you think.
- **Compare against the base branch before blaming your work.** Check out the
  base in a separate worktree and run the same command there. Do not use stash
  for this — it has produced wrong answers here.

## Where the truth lives

When this file and the code disagree, the code wins — and then fix this file.

- Constitutional rules and the decision gate: `docs/CONSTITUTION.md`
- Repo-wide working rules: `CLAUDE.md` (Claude Code) and `AGENTS.md` (other agents)
- Visual system and its red lines: `docs/DESIGN.md`
- Prompt assembly contract: `docs/RUNTIME-PROMPT-ARCHITECTURE.md`
- Skill authoring contract: `docs/SKILL-SPEC.md`
- Module-by-module design, dependencies and call paths: `docs/atlas/` (see its README to regenerate)
