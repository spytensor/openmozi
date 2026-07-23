# MOZI Phase 1 E2E Acceptance Plan

This document is the local end-to-end acceptance protocol for MOZI Phase 1.

Phase 1 is terminal-first. Desktop/computer-use scenarios are intentionally deferred and are not part of the Phase 1 release gate.

## Purpose

The goal of this plan is to prove that MOZI can complete real operator tasks end-to-end through its actual runtime, rather than only passing unit tests or producing convincing narration.

## Scope

Included in Phase 1:

- terminal and filesystem execution
- persistent task management and task repair
- task decomposition and DAG execution
- workspace/bundled/git skill installation and runtime state
- managed worker execution and truthful worker state reporting

Deferred from Phase 1:

- desktop/computer-use acceptance
- voice-channel acceptance
- multi-tenant acceptance beyond basic isolation already covered elsewhere

## Required Evidence For Every Scenario

For each scenario, capture:

- user input / objective
- real runtime path used
- changed files, if any
- test/build/tool output
- final user-visible response
- failure reason, if blocked

## Execution Rules

- Use the real runtime path, not isolated internals.
- Do not mock the worker result as a substitute for a full run.
- Do not count a scenario as passed if the final answer contradicts runtime state.
- If a scenario adds a new feature area, the same change must also add or update automated local tests.

## Release Gate Scenarios

These are the minimum E2E scenarios required for a Phase 1 release.

### E2E-01 Repo Inspection

Objective:
MOZI inspects a real repository and reports stack, scripts, and main entrypoints.

Flow:
User request -> Brain -> `read_file` / `list_directory` / `shell_exec` -> final summary.

Pass criteria:
- The answer cites real files or scripts.
- No fabricated file paths or package scripts appear.

### E2E-02 Small Code Fix Loop

Objective:
MOZI fixes a real small bug in the repo and verifies the result locally.

Flow:
Read code -> edit file -> run targeted tests or build -> return verified result.

Pass criteria:
- At least one file changes.
- At least one local verification command runs.
- Final answer matches the actual diff and test/build result.

### E2E-03 Long-Running Terminal Job

Objective:
MOZI starts, monitors, and stops a long-running terminal process.

Flow:
`shell_exec_bg` -> `process_status` / `process_output` -> optional `process_kill`.

Pass criteria:
- A real background process ID is created.
- Runtime can query status/output and stop it.
- No fake completion text appears.

### E2E-04 Persistent Task Control Plane

Objective:
MOZI creates and inspects durable tasks instead of relying only on narration.

Flow:
`create_task` -> `list_tasks` / `get_task` / `update_task` -> `/tasks`.

Pass criteria:
- Tasks persist with real IDs, status, dependency info, and event history.
- `/tasks` reflects the same state shown by the tools.

### E2E-05 Persistent Task Execution

Objective:
MOZI executes an existing persistent task through the task runtime.

Flow:
`run_task` -> task scope build -> `executeDag` / in-process runtime -> state update.

Pass criteria:
- The task transitions through real runtime state.
- The result is tied to the persistent task, not only to the current chat turn.

### E2E-06 Persistent Task Repair

Objective:
MOZI diagnoses and repairs a recoverable failed task.

Flow:
`repair_task diagnose` -> `repair` or `repair_and_run`.

Pass criteria:
- Failure classification is grounded in real runtime state/events.
- Reset and rerun, if used, are real state transitions.

### E2E-07 DAG Decomposition

Objective:
MOZI decomposes a complex request into multiple subtasks and executes them through the DAG path.

Flow:
`decompose_task` -> task store -> DAG executor -> aggregated result.

Pass criteria:
- The task graph contains 2+ subtasks.
- Dependency order is respected.
- Final result reflects subtask outcomes.

### E2E-08 `/tasks` Command Truthfulness

Objective:
The `/tasks` command shows live task truth, not placeholder text.

Flow:
Create active/blocked/failed tasks -> run `/tasks`, `/tasks failed`, `/tasks <query>`.

Pass criteria:
- Output matches actual runtime task state.
- Filters behave correctly.

## Strongly Recommended Phase 1.5 Scenarios

These scenarios should be completed before widening the product surface further.

### E2E-09 Workspace Skill Install (Local Path)

Objective:
MOZI installs a SKILL.md asset from a local path into the workspace and reports its runtime state.

Flow:
`install_skill source=path` -> `validate_skill` -> `list_runtime_skills` -> `/skills`.

Pass criteria:
- Skill lands in workspace.
- Runtime reports source, state, and missing requirements truthfully.

### E2E-10 Workspace Skill Install (Git)

Objective:
MOZI installs a skill from an https git repository and optional subpath.

Flow:
`install_skill source=git` -> clone -> workspace install -> validate -> list.

Pass criteria:
- Install succeeds with a real cloned source.
- Runtime state is visible through tools and `/skills`.

### E2E-11 Skill Enable/Disable Truthfulness

Objective:
Disabled workspace skills do not appear as active runtime capability.

Flow:
`set_skill_state false` -> `list_runtime_skills` / `/skills` -> `set_skill_state true`.

Pass criteria:
- Disabled skills are not injected or claimed as active.
- Re-enabled skills become visible again without prompt drift.

### E2E-12 Managed Worker Real Run

Objective:
MOZI delegates a real coding task to a managed worker and reports truthful state.

Flow:
preflight -> dispatch -> durable job state -> verifier/result collection.

Pass criteria:
- A real worker job launches.
- Worker state is persisted and queryable.
- Final user answer matches worker/verifier truth.

## Suggested Recording Template

Use this template for each run:

```md
## Scenario: E2E-XX Name

- Date:
- Operator:
- Branch/commit:
- Objective:
- Runtime path:
- Evidence:
  - input:
  - changed files:
  - tests/build output:
  - final user-visible response:
- Result: pass/fail
- Notes:
```

## Exit Rule

Phase 1 is not considered converged until:

- all release gate scenarios pass on the current branch
- no scenario relies on placeholder or fabricated runtime claims
- relevant local automated tests exist for the changed behavior
