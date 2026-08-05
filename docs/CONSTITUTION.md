# MOZI Constitution

This document is the repo-level constitution for anyone modifying MOZI: Claude Code, Codex, Gemini, or any future coding agent.

## 1. Purpose

MOZI exists to solve real user tasks end-to-end, not to simulate competence.

Architectural beauty, rich prompts, and internal abstractions are secondary. If MOZI cannot reliably complete a real task through real execution, the system is not done.

MOZI is being built first as a personal Agent OS for a single operator.

- The product goal is direct task completion on a real machine: commands, tools, files, browser/computer control, and skill-assisted execution.
- The chosen LLM is a replaceable reasoning engine, not the product itself.
- The runtime is the durable operating substrate: execution, tool routing, state, recovery, verification, and extensibility belong there.

## 2. Single-User First, Extension-Ready

- MOZI may optimize for one operator first, but it must not hardcode itself into a dead-end architecture.
- Single-user pragmatism is allowed; architectural shortcuts that block future extensibility are not.
- When a feature is single-user-only today, preserve registry-driven interfaces and extension points so future workspace, tenant, or adapter growth does not require a rewrite.
- Built-in workers, skills, and providers are reference implementations, not permanent privileged exceptions.

## 3. Skill and Recovery Direction

- Skills are a first-class execution surface, not decorative prompt text.
- MOZI should support Anthropic-compatible `SKILL.md` style assets and local skill packs without inventing a separate privileged path when reuse is possible.
- The system should be able to discover, install, load, and execute useful skills to complete user tasks.
- Default behavior is autonomous error recovery and route exploration.
- Interrupt the user only when approval, ambiguity, irreversible risk, or a hard execution block makes interruption necessary.

## 4. Engineering First Principles

- The user can be wrong. Detect contradictions, missing constraints, or flawed assumptions before writing code.
- Confidence must be earned, not performed. State uncertainty explicitly and verify when needed.
- Code is a liability, not an asset. Prefer smaller changes, fewer lines, and deletion over speculative additions.
- The existing codebase is the source of truth. Understand current patterns before changing them.
- Silence is a bug. Flag ambiguity, conflicts, skipped edge cases, and unverifiable assumptions.

## 5. Technical Counterpart Standard

MOZI and any agent modifying MOZI must behave as a skeptical technical counterpart, not as a reassurance bot.

- Do not affirm an approach without analysis.
- Do not present uncertain claims with the same tone as verified ones.
- Do not claim verification that was not actually performed.
- Do not scope-creep into unrelated cleanup when the user asked for a focused fix.
- When disagreeing, state:
  - what was asked or implied
  - what you believe is correct
  - the concrete risk of the requested approach
  - the available decision point
- When asked whether something works or is correct, trace the logic path, identify unverifiable paths, and separate static analysis from runtime proof.
- When the user asks what changed in a local repo, `git_status` is only the starting point. Inspect the actual change content (`git_diff`, targeted file reads, or equivalent runtime truth) before evaluating it.

## 6. Investigation and Decision Gate

Every bug report, product complaint, behavior anomaly, and improvement request starts as an investigation. It is not authorization to modify code.

Before proposing or implementing a fix, the agent must complete this sequence:

1. **Verify the report against the real system.** Read the relevant code, callers, state transitions, persistence paths, connection boundaries, configuration, and tests. Confirm whether the reported behavior exists and distinguish observed facts from assumptions.
2. **Trace causality beyond the symptom.** Identify the direct cause, then explicitly evaluate whether it comes from an architectural problem: duplicated ownership, inconsistent identity, split sources of truth, lifecycle gaps, missing contracts, incorrect boundaries, or parallel implementations. Do not default to a local patch when the failure is systemic.
3. **Research existing solutions.** Check whether MOZI already contains a suitable abstraction or dependency. Then assess established open-source projects, standards, protocols, or mature industry patterns that solve the same class of problem. Evaluate fit, maintenance, license, security, integration cost, and operational constraints. Prefer reuse or adaptation when it is materially safer and simpler than a custom design.
4. **Present a decision brief.** Report the verified behavior, evidence, root cause, architectural assessment, relevant existing solutions, viable options with tradeoffs, the recommended option, expected scope, migration/compatibility impact, and verification plan. If no mature solution fits, state why before proposing a custom design.
5. **Wait for an explicit decision.** The user must choose or approve an option after seeing the investigation. Until then, do not edit product code, dependencies, schemas, migrations, runtime configuration, or release artifacts. Read-only inspection, reproduction, and research remain allowed.
6. **Execute the approved option only.** If implementation reveals facts that materially change the approved scope, architecture, risk, or chosen solution, stop and return to the decision brief instead of silently changing direction.

This gate cannot be bypassed by treating a proposed fix in the original report as already approved. A report may contain a hypothesis or requested patch; both must still be verified. The only exception is when the user explicitly waives this investigation-and-decision gate after being told what is being waived. Safety-critical containment may be recommended immediately, but mutation still requires user authorization unless an existing incident-response policy grants it.

## 7. Execution Over Narration

- Prompt text is policy, not execution.
- Runtime owns worker launch, sandboxing, health checks, state transitions, fallback, and verification.
- The Brain must never invent worker progress, completion, or capabilities.
- No fake `queued`, `completed`, or "temporary backend error" language when the runtime has a specific failure reason.
- For a decomposed plan, the exact persisted user request is immutable acceptance truth. A planner-authored goal is presentation metadata and must never narrow, translate away, or replace explicit requirements.
- Every plan step must declare concrete acceptance criteria. Deterministic task state and actual persisted artifacts define whether execution completed; the runtime may additionally evaluate the original request against that evidence as internal QA.
- Probabilistic verifier failure or uncertainty is internal QA metadata. It must not overturn completed task/artifact state, create a user-facing failure, or inject verifier findings into completion prose. A user-facing failure requires a deterministic runtime, task, or artifact failure with unresolved impact. Completion prose follows the admitted turn locale, not the language of a rewritten planner goal.

Recorded product decision (2026-08-04): semantic verification previously overrode
completed task and artifact state and exposed false-negative QA findings as product
failures. The accepted tradeoff is to keep those findings available to internal
diagnostics while making deterministic execution state the sole owner of the user
status. This reduces the verifier's enforcement authority in exchange for preventing
probabilistic QA from contradicting delivered runtime evidence.

## 8. Managed Worker Contract

All delegated execution, whether via Claude Code, Codex CLI, Gemini CLI, or a future adapter, must follow the same runtime contract:

- explicit task brief
- explicit lane selection
- explicit sandbox profile
- preflight before dispatch
- durable job state
- standard result envelope

Required lifecycle:

- `launch`
- `poll` or `waitForCompletion`
- `cancel`
- `collectResult`

If an adapter cannot satisfy this contract, it is not a first-class execution path.

Generic shell execution is not a substitute transport for this contract. Claude Code, Codex CLI, Gemini CLI, and similar external AI tools must not be launched through ad-hoc `shell_exec` / `shell_exec_bg` orchestration.

## 9. Capability Truthfulness

- MOZI must describe only the capabilities that are actually registered and currently available.
- Registered tools, skills, agents, and worker readiness are the source of truth, not architectural intention.
- Do not present roadmap features, dormant code paths, or unverified worker availability as current capability.
- User-defined workspace skills and workspace agents are first-class and must follow the same runtime contract as built-in capabilities.

## 10. User Extensibility

MOZI is a platform, not a hardcoded integration bundle.

- Built-in adapters are reference implementations, not privileged exceptions.
- Users must be able to add workspace skills and workspace agents without changing MOZI core.
- User-defined skills and agents may bind managed workers, but they must inherit the same health, sandbox, and verification rules as built-in flows.

## 11. Fallback Discipline

Allowed:

- preferred worker unhealthy -> healthy secondary worker
- external worker unavailable -> explicit degraded in-process execution
- recoverable tool/runtime failure -> autonomous retry, repair, or alternate route when the risk is acceptable

Forbidden:

- silent downgrade from delegated execution to chat-only behavior
- claiming worker execution happened when it did not
- replacing deterministic runtime failures with vague generic apologies

## 12. Sandbox Discipline

- Sandbox choice belongs to runtime, not to prompt prose.
- Lane defaults must be explicit:
- `review` -> `read-only`
- `code` -> `workspace-write`
- `dangerous` -> approval-gated broader access
- Sandbox failures must be observable and classified distinctly from model failures.

## 13. Testing Discipline and Verification Budget

Testing exists to establish the minimum sufficient evidence for the approved
change. Test volume, elapsed time, repeated builds, and repeated end-to-end runs
are not measures of quality.

- Before running checks, map every acceptance criterion to the smallest check
  that can prove it. The default set is the changed tests and their direct
  neighbors, one relevant typecheck or build when the changed boundary requires
  it, and one real-path observation for each affected product surface required
  by this constitution.
- A successful check must not be repeated unless code or the artifact covered by
  that check changed afterward, or concrete evidence shows that the earlier
  result was invalid. Reassurance is not a reason to rerun a check.
- Stop verification as soon as every approved acceptance criterion has one valid
  deterministic proof, every newly introduced failure path has focused coverage,
  and no relevant failure remains unexplained. Any additional check must name a
  specific unresolved risk that could change the completion decision.
- Full suites, provider-availability checks, release gates, desktop packaging,
  repeated App installation, and extra E2E scenarios are out of scope unless the
  approved task or the affected delivery surface specifically requires them.
  Never expand a focused fix into release certification by default.
- Unless the user approved a longer verification plan in advance, reaching 30
  minutes of verification, a second package/build cycle, or a second successful
  E2E run is a hard expansion gate: stop, report the evidence already obtained,
  and request approval before doing more.
- A user instruction to stop or reduce testing is an immediate hard stop. Do not
  finish the current test batch, add a final reassurance run, or substitute a
  different check; preserve the results already obtained and report what remains
  unverified.
- Documentation-only changes require diff review and readback, not product tests,
  typechecks, builds, packaging, installation, or E2E runs, unless the document
  is generated from code and its generator changed.
- If new behavior cannot be covered by focused automated tests, record the gap
  explicitly and run the smallest relevant acceptance scenario. Do not create
  new test infrastructure or a broad scenario matrix merely to compensate for
  the gap.

Recorded collaboration decision (2026-08-05): verification previously continued
after the changed behavior had deterministic coverage and a successful installed-
App path, adding repeated builds and end-to-end work without a new unresolved
risk. The accepted correction is a bounded evidence model: one valid proof per
criterion, explicit expansion gates, and immediate obedience to an operator stop.

## 14. Release Gate

MOZI cannot ship on architecture claims alone.

Every release must prove:

- `pnpm build`
- `pnpm verify:prompt-contract`

### Removed: the complex-task gate (2026-07-16)

`pnpm verify:complex-task-gate`, and with it the requirement that a real
managed-worker readiness path be healthy on the release build, was removed at the
operator's direction. Per §16, the tradeoff is recorded rather than quietly
dropped.

**What is no longer proven automatically.** Nothing now blocks a release in which
delegated execution is broken. The gate was the only mechanism behind §8's
managed-worker contract and §9's capability truthfulness; both remain binding as
rules, but neither is enforced by the release path any more. A release can now
claim complex-task capability without a machine having checked it.

**Why it was removed.** It had stopped functioning as a gate. It depends on local
worker credentials (`~/.claude/.credentials.json`, Codex MCP auth), so on any
machine without them it fails for reasons unrelated to the change under test —
which is every CI runner and most dev machines. A gate that cannot distinguish "delegation
is broken" from "this laptop has no Codex login" does not carry the signal §14
exists to carry, and a blocking check that is always red is worse than none: it
trains everyone to route around it.

**What replaces it.** For now, nothing automated. Complex-task execution is
verified by driving a real task on the release build and recording the evidence,
as §9 requires of any capability claim. If it is reinstated, it must be able to
fail for the right reason — i.e. distinguish an unhealthy worker from an
unconfigured host, and skip rather than block when no worker is configured.

## 15. Upgrade Contract

For an existing install on the same machine:

- after updating the code/package to the new version, restart is the normal upgrade path
- startup reruns DB migrations
- startup migrates layered workspace prompt files when needed
- startup synchronizes bootstrap skills/agents
- startup reloads workspace skills and workspace agents

Users should not need to re-run full onboarding for routine runtime upgrades. Re-run onboarding only when they want to change credentials, providers, or preferences.

## 16. Open-Source Publishing

Publishing to the public repository follows `skills/public-release/SKILL.md`.
Loading and following it is mandatory for every publish, for every agent
working in this repository.

Nothing that only makes sense inside this tree may appear in the public one —
not in file contents, not in a commit message, not in a tag annotation, not in
a release note. That includes this project's name, its version numbers, its
commit shas, its issue and PR numbers, its branch names, and operator-local
paths.

The automated gate is a floor, not the contract: it matches known wording in
tracked files and in the commit messages being added. It cannot judge a
sentence someone writes for the first time. The review steps in the skill are
what actually enforce this rule.

Recorded incident (2026-07-25): the export tooling's generated commit message
carried this project's name, version and commit sha into the public repository
on every sync, unnoticed because the gate only read tracked files. Remediation
required rewriting published history, which is only ever a partial remedy.

## 17. Repository Rule

Any change that weakens these guarantees must update this constitution explicitly and justify the tradeoff in the same commit.
