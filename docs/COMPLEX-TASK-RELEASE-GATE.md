# Complex Task Release Gate

> Release-blocking checklist for proving that MOZI can complete at least one real complex task.

---

## Purpose

This gate exists to prevent "beautiful but non-executing" releases.

A version must not ship if MOZI cannot complete a real complex task through its actual runtime path.

---

## 1. Required Scenario

Run MOZI against a disposable repository or fixture repo with a task that requires all of the following:

- multi-step reasoning
- code edits in more than one file
- at least one test or build command
- final result summarization

Recommended examples:

- fix a failing test and update implementation
- add a small feature and its tests
- review a diff, request changes, then apply the fix

The scenario must be real enough that plain chat-only behavior would fail.

---

## 2. Mandatory Execution Path

The run must exercise the real production path:

- normal gateway entry
- normal task decomposition or subagent path
- real external worker delegation when configured
- real verifier/completion logic

Disallowed:

- mocking the worker result
- manually invoking adapter internals as a substitute for a full run
- using a simplified debug path not reachable in production

---

## 3. Preflight Checklist

Before the run:

- `claude` and/or `codex` command exists
- local auth exists for the selected worker
- worker probe succeeds
- repo root resolves correctly
- selected lane and sandbox profile are visible
- telemetry/log capture is enabled

If preflight fails, the release is blocked until the reason is classified.

---

## 4. Pass Criteria

A release passes this gate only if all items below are true:

1. MOZI accepts the complex task without collapsing into generic chat mode.
2. The task is decomposed or delegated through the intended runtime path.
3. A real worker job is launched and tracked with a job/trace id.
4. Code changes are applied in the target repo.
5. Tests or build commands are executed and their real results are captured.
6. The final response reflects the actual worker result and verification state.
7. No generic fake-success text appears.
8. No worker failure is masked as a temporary backend error.

---

## 5. Release Blockers (checked by hand)

Any one of these fails the gate. Nothing checks them automatically — `verify:complex-task-gate` was removed on 2026-07-16 (see `docs/CONSTITUTION.md` §14), so these hold only if a human looks:

- delegated task returns placeholder queue text
- worker launch path is skipped unexpectedly
- worker state is missing or not persisted
- repo-root resolution is wrong
- sandbox mismatch prevents the expected lane from operating
- tests/build are not executed when the task requires them
- final response contradicts worker/verifier state
- Mozi falls back silently without telling the user

---

## 6. Evidence to Store

Every release-gate run must leave evidence that can be reviewed later:

- task prompt or objective
- selected worker and lane
- sandbox profile
- job id / trace id
- changed files
- tests/build command and result
- final summary shown to the user
- failure category if blocked

Store this evidence in the release notes, release PR, or a release artifact bundle.

---

## 7. Suggested Command Sequence

Use this as a minimum release gate sequence:

```bash
pnpm test:unit
pnpm mozi status --workers --live-probe
```

> `pnpm verify:complex-task-gate` was removed on 2026-07-16 — see
> `docs/CONSTITUTION.md` §14 for what is no longer proven automatically and why.
> Until something replaces it, the real-scenario evidence below is the only proof
> that complex-task execution works; it is now a manual step, so it is the step
> that actually matters.

Then run one real complex-task scenario and capture:

- gateway logs
- worker logs
- changed files
- test output
- final user-visible summary

If the run fails, do not cut the release.

---

## 8. Human Review Questions

Before release, answer these questions explicitly:

1. Did MOZI really delegate the task, or just talk about doing it?
2. Did the selected worker have the right sandbox profile for the lane?
3. Did verifier state match the final answer?
4. Would a user trust this run as evidence that MOZI can execute complex work?

If any answer is "no", the release is blocked.

---

## 9. Exit Rule

No release is considered healthy until this gate passes on the current branch and current runtime build.
