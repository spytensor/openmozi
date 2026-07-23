# Runtime Prompt Architecture Contract

> Engineering contract for the MOZI runtime prompt and context system.
> This document constrains implementation — future PRs should reference it.
> Author: Chaojie + Mozi · March 2026
>
> **Merge order:** This document should land after PR #169 (observability snapshots)
> and PR #170 (tool shaping). Some modules referenced below are introduced in those PRs.

---

## Core Principle

**The LLM Brain makes ALL decisions. Infrastructure exists to execute what the Brain decides.**

Do not solve structural problems with more prompt text. If the Brain misbehaves:
1. Check if the context compiler is feeding it correct/sufficient information
2. Check if tool shaping is exposing the right tools
3. Check if verifier gates are catching the failure class
4. Only then consider prompt changes — and keep them minimal

---

## 1. Immutable Core Prompt vs Runtime-Generated Context

### Immutable Core Prompt
- Lives in `src/templates/SOUL.md`
- Defines identity, personality, safety boundaries, and operating principles
- Loaded once per session, occupies the `identity` slot in the context compiler
- **Must never contain runtime state, tool lists, or dynamic content**
- Changes require deliberate review — this is the Brain's DNA

### Runtime-Generated Context
- Assembled per-turn by the context compiler (`src/memory/context-builder.ts`)
- Includes: user profile, project knowledge, memory facts, lessons, digests, active skills, skills catalog
- Task-type workflow guidance is NOT injected by keyword routing — it lives in bundled workflow skills (research-workflow, data-analysis, document-authoring, creative-writing, financial-analysis, self-ops) that the Brain activates via `use_skill`
- Each piece occupies a named slot with explicit token budget, priority, and fallback rules
- **All dynamic context flows through slots — never injected ad-hoc into the system prompt string**

### Anti-pattern: Prompt Bloat
Never add inline directives, verification instructions, or capability claims directly into prompt strings.
If you need the Brain to know something, it belongs in a context slot or a runtime message.

---

## 2. Runtime Message IR

**Module:** `src/gateway/runtime-message-ir.ts`

Messages in the turn loop are annotated with `runtime_kind` to distinguish their origin:

| Kind | Purpose | Example |
|------|---------|---------|
| `user_input` | Original user message | "Fix the login bug" |
| `system_policy` | System prompt / policy | SOUL.md content |
| `runtime_meta` | Runtime metadata | Time anchors, context refresh |
| `tool_truth` | Tool execution results | File contents, shell output |
| `memory_context` | Extracted memory/facts | Retrieved lessons, digests |
| `verifier_feedback` | Completion gate feedback | "Run tests before completing" |

**Invariant:** Tool results (`tool_truth`) are ground truth. The Brain must never override or reinterpret them.
Runtime meta messages are ephemeral and may be compressed. Verifier feedback messages drive the completion gate loop.

---

## 3. Slot-Based Context Compiler

**Module:** `src/memory/context-builder.ts`

The context compiler assembles the full prompt from named slots, each with:

| Property | Purpose |
|----------|---------|
| `name` | Slot identity (`identity`, `memory_facts`, `skills`, etc.) |
| `priority` | Executable budget-allocation order (100 = highest; declaration order breaks ties) |
| `tokenCap` | Independent ceiling for this slot, not a reserved share or guaranteed partition |
| `dedupeRule` | How duplicates are detected (`exact`, `line`, `message_identity`) |
| `freshnessRule` | When content should be refreshed (`immutable`, `live_profile`, etc.) |
| `fallbackRule` | What to do when over budget (`trim`, `omit`, `summary`) |

**Slot priority order:**
1. `identity` (100) — immutable system prompt
2. `user_profile` (90) — live user preferences
3. `project_knowledge` (85) — live project context
4. `session_deliverables` (83) — runtime-verified deliverable paths for the active session
5. `memory_facts` (80) — stable long-term facts
6. `turn_memory` (78) — retrieval-scored facts for the current turn
7. `lessons` (75) — ranked operational lessons
8. `episodic_digests` (70) — recent session summaries
9. `active_skills` (55) — full instructions for explicitly activated skills
10. `skills` (50) — matched skill descriptions
11. `recent_history` (40) — conversation tail

**Budget contract:** The system-slot budget is
`min(availableContextBudget, max(768, floor(availableContextBudget * 0.6)))`.
It is normally 60% of available context, but the 768-token floor makes it a
larger share for small budgets (up to all available context at 768 tokens or
less). History receives what remains after the compiled system and turn-context
messages. System-slot fractions are independent ceilings and intentionally sum
to 1.38; the 256-token minimum can raise their sum further for small budgets.
They are not reservations. Slots allocate in priority order and deduct from one
`remainingSystemBudget`, so the hard invariant is that total system-slot tokens
never exceed `systemSlotBudget`, which itself never exceeds available context.

Allocation order and message placement are separate contracts. After fitting,
stable slots are emitted in the cacheable system prefix and volatile slots are
emitted after append-only history; changing `priority` does not silently move a
slot between those groups.

`trim` keeps the prefix that fits, `omit` is all-or-nothing and commits no
dedupe state when it does not fit, and `summary` is reserved for the separate
recent-history reducer. A system slot declaring `summary` is a configuration
error.

**Output:** `CompiledContextResult` with messages, slot breakdown, and budget accounting.

**Invariant:** Every piece of context the Brain sees came through a slot. Slot breakdowns are observable via prompt snapshots.

---

## 4. Context Compression And Durable State

Conversation compression is implemented by `src/core/running-summary.ts` and is
lossy. Durable task, checkpoint, worker, and session state lives in the
production stores and is reloaded through normal context slots; MOZI does not
claim a separate automatic reasoning-state checkpoint or protected prompt
message.

---

## 5. Unified Execution Kernel

**Module:** `src/core/unified-execution-kernel.ts`

The execution kernel manages the Brain's tool-call loop:
- Iteration budget (max iterations, timeout, token budget)
- Stop conditions (empty response, max failures, budget exhaustion)
- Abort signal propagation
- Loop state tracking (current iteration, elapsed time)

**Invariant:** The kernel does not make decisions — it enforces resource boundaries. The Brain decides what to do; the kernel decides when to stop.

---

## 6. Task-Aware Tool Shaping

**Module:** `src/tools/tool-shaping.ts`

Before each LLM call, the tool list is filtered based on the detected task type and model execution profile. Strong general-purpose reasoning models keep the full general tool surface; weak-tool-use and non-reasoning models receive a smaller schema plus compact runtime guidance.

| Task Type | Includes | Excludes |
|-----------|----------|----------|
| `coding` | shell, git, test, edit, web | browser |
| `research` | web, browser, analyze | shell, git-mutation, test, edit |
| `office` | file write, shell, artifact, web, test | browser, git |
| `data` | shell, file write, web | browser, git-mutation |
| `creative` | file write, shell, artifact, web, analyze | git, browser, test |
| `finance` | web, shell (read), file write | browser, git-mutation |
| `desktop` | desktop, browser, analyze | shell, git, file mutation |
| `general` | core, file, shell, task, artifact, web, runtime control | desktop, browser, git |

**Core tools** (read_file, list_directory, remember, recall, recall_episodes, read_context) are always available.

**Dynamic/unknown tools** are never filtered — only known builtins are shaped.

Prompt snapshots record the chosen task/model profile, exposed-tool count, and approximate prompt/tool-schema token weight. This makes reductions and model-specific regressions visible instead of relying on prompt intuition.

**Invariant:** Tool shaping reduces prompt weight and side-effect risk. The Brain never sees tools it doesn't need for the current task.

---

## 7. Managed Worker / Job / Result Envelope

**Modules:** `src/workers/adapter.ts`, `src/workers/dispatch.ts`, `src/workers/job-state.ts`

### Worker Lifecycle
1. **Dispatch:** `dispatchManagedWorkerTask` selects adapter, launches worker, persists job state
2. **Poll:** Job state tracks `queued` → `launching` → `running` → `completed_pending_verify` / `failed` / `timed_out`
3. **Result:** Worker returns a `ResultEnvelope` with status, output, summary, cost, issues
4. **Verify:** Job enters `completed_pending_verify` until verifier reviews

### Result Envelope Schema
Zod schema: `ResultEnvelopeSchema` in `src/agents/protocol.ts`
```
ResultEnvelope {
  task_id, status, output[], summary,
  cost { tokens, tool_calls, elapsed_time },
  issues[], changed_files[], tests_run[],
  test_status, artifacts[], blocker
}
```

### Verify Report Schema
Zod schema: `ExternalWorkerVerifyReportSchema` in `src/workers/job-state.ts`
```
ExternalWorkerVerifyReport {
  job_id, status (pending|passed|failed|skipped),
  summary, acceptance_criteria_met[], acceptance_criteria_missing[],
  tests_checked[], artifact_check, diff_summary, notes[]
}
```

**Invariant:** Worker results never surface as "completed" while verification is pending. The task dispatcher downgrades `success` to `partial` when verify_status is not `passed`.

---

## 8. Verifier-First Completion Model

**Module:** `src/core/completion-gates.ts`

The completion gate tracks mutations and verification steps during a turn:

### Tracked Evidence
- **Code file mutations** (write_file/edit_file on .ts/.py/.js/etc.) → require `git_diff` + `run_tests` after last mutation
- **Non-code file mutations** → require `read_file` readback after mutation
- **Test results** → parsed for pass/fail status

### Gate Evaluation
- `not_required` — no mutations in this turn
- `pending` — mutations detected, verification steps not yet run
- `passed` — all required verification completed successfully
- `failed` — tests failed or verification explicitly failed

### Gateway Integration
When the Brain attempts to finalize a response:
1. `evaluateCompletionGate(state)` checks if all verification is complete
2. If `pending` or `failed`: response is blocked, verifier feedback injected as runtime message, loop continues
3. If `passed` or `not_required`: response is delivered to user

**Invariant:** The Brain cannot claim task completion without passing verification. This is enforced at the gateway level, not via prompt instructions.

---

## 9. Observability / Replay

**Modules:** `src/observer/telemetry.ts`, `src/observer/prompt-snapshot.ts`, `src/observer/failure-replay.ts`, `src/observer/regression-harness.ts`

### Turn Traces
Every turn produces a trace with: status, verify_status, verify_summary, tool_call_count, tool_failure_count, token usage, cost, latency.

### Prompt Snapshots
Per-trace snapshots capture: slot breakdown, tool exposure list, verifier state, runtime meta counts. Persisted with automatic secret redaction.

### Failure Replay
Failed traces can be exported as fixtures and replayed with mock tool/provider overrides to verify that runtime changes improve (or don't regress) known failure classes.

### Regression Harness
Batch runner for multiple regression fixtures with structured assertions, per-category reporting, and formatted summaries.

**Invariant:** A failed trace must reveal the compiled prompt/context structure that produced it. Prompt tuning without snapshot evidence is flying blind.

---

## Implementation Constraints

1. **No ad-hoc prompt injection.** All context flows through slots or runtime messages.
2. **No verification via prompt.** Completion gates enforce verification at the gateway level.
3. **No tool filtering via prompt.** Tool shaping removes tools before LLM call.
4. **No hardcoded LLM reasoning.** The Brain decides; infrastructure constrains and observes.
5. **All state is observable.** Slot breakdowns, tool exposure, verifier decisions are persisted and queryable.
6. **Worker results respect verification.** No "completed" status without verifier approval.

---

## Module Reference

| Concept | Module | Key Function |
|---------|--------|-------------|
| Context compilation | `src/memory/context-builder.ts` | `compileIntelligentContext()` |
| Runtime message IR | `src/gateway/runtime-message-ir.ts` | `createRuntimeMessage()` |
| Conversation compression | `src/core/running-summary.ts` | `compress()` |
| Execution kernel | `src/core/unified-execution-kernel.ts` | `UnifiedExecutionKernel` |
| Tool shaping | `src/tools/tool-shaping.ts` | `shapeToolsForTask()` |
| Completion gates | `src/core/completion-gates.ts` | `evaluateCompletionGate()` |
| Worker dispatch | `src/workers/dispatch.ts` | `dispatchManagedWorkerTask()` |
| Prompt snapshots | `src/observer/prompt-snapshot.ts` | `capturePromptSnapshot()` |
| Failure replay | `src/observer/failure-replay.ts` | `exportFailureReplayFixture()` |
| Regression harness | `src/observer/regression-harness.ts` | `runRegressionSuite()` |
