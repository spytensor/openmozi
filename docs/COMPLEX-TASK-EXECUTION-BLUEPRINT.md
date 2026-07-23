# Complex Task Execution Blueprint

> Runtime contract for making MOZI complete real complex tasks through external workers.
> This is an execution design, not a prompt-writing exercise.

---

## 1. Core Thesis

MOZI will not become "Claude Code with a team" through prompt polish alone.

Complex-task execution must be implemented as a runtime system with:

- a real worker abstraction
- explicit health and sandbox profiles
- durable task/job state
- verifier-driven completion
- release gates based on real end-to-end execution

Prompt text should remain thin. It decides when to decompose or delegate. It must not fake worker state, completion, or tool reality.

---

## 2. Non-Negotiable Invariants

1. The Brain never invents worker progress or completion.
2. A delegated task is not "done" until a worker result contract is collected.
3. Worker availability is decided by runtime health, not by prompt optimism.
4. Sandbox mode is explicit per task lane, not a hidden global guess.
5. Complex-task capability is release-blocking and must be proven with a real end-to-end run.

---

## 3. Layering

### Prompt Layer

Responsibilities:

- decide whether the task should stay in-process or delegate
- describe the objective and acceptance criteria clearly
- summarize worker output for the user

Must not own:

- CLI launch details
- repo-root resolution
- timeout strategy
- sandbox selection
- cancellation semantics
- verification gates

### Runtime Layer

Responsibilities:

- compile a `TaskBrief`
- select a healthy worker lane
- launch and monitor the worker
- persist job state
- collect result envelope
- enforce verification before completion

### Worker Layer

Responsibilities:

- execute the task in a controlled environment
- return a standard result envelope
- expose cancellation and terminal states

---

## 4. Standard Contracts

### Task Input

Every delegated task must be reduced to:

- `task_id`
- `objective`
- `done_criteria`
- `constraints`
- `hints`

This already maps to MOZI's `TaskBrief`.

### Worker Interface

Every external worker adapter must support the same lifecycle:

- `launch`
- `poll` or `waitForCompletion`
- `cancel`
- `collectResult`

Claude Code, Codex CLI, and future workers are adapters, not separate architectures.

### Result Contract

Every worker must return a standard result envelope:

- `status`
- `summary`
- `output`
- `cost`
- `issues`

If the worker cannot return this envelope, the run is a failure.

---

## 5. Worker Lanes

MOZI should route complex execution through explicit lanes.

### `review`

- default sandbox: `read-only`
- expected tools: filesystem, search, tests that do not mutate repo
- suitable workers: Claude Code, Codex CLI

### `code`

- default sandbox: `workspace-write`
- expected tools: filesystem, shell, tests
- suitable workers: Claude Code, Codex CLI

### `dangerous`

- default sandbox: approval-gated native/full access
- expected tools: destructive git, deployments, remote side effects
- requires hard gate approval and audit trail

Lane selection must be runtime-visible and logged with the job.

---

## 6. Health and Preflight

Delegation must be blocked unless preflight passes.

### Static checks

- command exists in `PATH`
- auth material exists
- configured adapter is valid
- requested sandbox profile is supported

### Live checks

- probe command succeeds
- recent failure category is not hard-blocking
- usage-limit state is not active
- timeout rate is below threshold

### Scheduling rule

The planner may only dispatch to workers that are currently healthy for the requested lane.

If no healthy worker exists:

- record the exact reason
- choose a defined fallback
- tell the user the degraded mode explicitly

---

## 7. State Machine

Every complex delegated task must move through explicit states:

1. `accepted`
2. `preflight`
3. `queued`
4. `launching`
5. `running`
6. `verifying`
7. `completed`
8. `failed`
9. `cancelled`
10. `timed_out`

Rules:

- terminal states are immutable
- cancellation is explicit
- timeout is not reported as generic backend failure
- verifier failure is distinct from launch failure

---

## 8. Fallback Policy

Fallback must be deterministic and observable.

### Allowed fallbacks

- external worker unavailable -> in-process execution
- preferred worker unhealthy -> secondary healthy worker
- worker verification failed -> task remains failed/partial, not silently "completed"

### Forbidden fallbacks

- fake "queued" success text
- silent downgrade from delegated execution to chat-only behavior
- replacing a worker error with a generic temporary-backend message

---

## 9. Sandbox Policy

Sandboxing is necessary, but it must be explicit and operationally sane.

### Design rules

- sandbox choice belongs to runtime, not the prompt
- the worker lane determines default sandbox profile
- upgrades to broader access require approval and audit
- sandbox failures must be classified separately from model failures

### Expected profiles

- `read-only`
- `workspace-write`
- `native/full-access` after approval

MOZI should never depend on a single global sandbox mode for all tasks.

---

## 10. Observability

Complex-task execution is not real unless it is inspectable.

Required evidence for every delegated task:

- selected worker adapter
- selected lane
- sandbox profile
- launch timestamp
- terminal state
- verifier status
- summary
- failure category if any
- trace or job id

The user-facing UI should show actual worker progress, not synthetic narration detached from state.

---

## 11. User Extensibility

MOZI must be extensible by the user, not only by core maintainers.

### Design rules

- registered managed workers such as Claude Code and Codex CLI are reference
  adapters, not privileged one-offs; unimplemented worker IDs are rejected
- workspace agents may declare `config.external_worker` and lane preferences without patching MOZI core
- workspace skills may invoke managed workers through the same task/result contract used by built-in skills
- user-defined skills must compose with the same runtime health, sandbox, and verification rules as core skills

### Consequence

The platform contract must stay stable enough that "MOZI + user-defined skills/agents" can grow into domain-specific operator workflows without new architecture every time.

---

## 12. Release Criteria

Complex-task execution is a release-blocking capability.

A release is not valid unless MOZI completes at least one real complex task end-to-end in a disposable repo with:

- planning or decomposition
- external worker delegation
- code changes
- test execution
- result summary
- persisted evidence

This requirement is formalized in `docs/COMPLEX-TASK-RELEASE-GATE.md`.

---

## 13. Implementation Order

1. Stabilize worker contracts and repo-root resolution.
2. Add health/preflight and lane-aware sandbox selection.
3. Make all preset delegation paths real, never placeholder.
4. Add end-to-end complex-task gate to release workflow.
5. Only after that, tune prompt behavior.

---

## 14. Definition of Done

MOZI can claim complex-task execution is working only when:

- a complex task is delegated to a real worker
- the worker mutates code and runs checks
- the result is collected through the standard contract
- verifier state is visible
- the user sees the true outcome
- the behavior is reproducible in release CI or a documented release gate run
