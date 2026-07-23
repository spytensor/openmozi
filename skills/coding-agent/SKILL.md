---
name: coding-agent
description: "Structured coding workflow: read, plan, implement, test, verify"
version: "1.0.0"
category: coding
user-invocable: true
always: true
requires:
  bins: []
  env: []
metadata:
  priority: 80
---

# Coding Agent

## When to Use
- User asks to implement a feature, fix a bug, or modify code
- User asks to build, create, or set up a project or component
- Any task that involves writing or modifying source code
- Always active: enforces the structured workflow for all coding tasks

## How to Execute

### Phase 1: Read & Understand
1. Read the relevant source files to understand the current state.
2. Identify the exact files, functions, and lines that need to change.
3. Check for existing tests, types, and conventions in the codebase.
4. Read any related config files, schemas, or documentation.

### Phase 2: Plan
1. State what will change and what will NOT change.
2. List every file to be modified or created.
3. If the change is non-trivial (>20 lines), describe the approach before writing code.
4. If the request conflicts with existing architecture, state the conflict and options.
5. Get user confirmation on the plan for large changes.

### Phase 3: Implement
1. Make the minimum change that satisfies the requirement.
2. Match existing code style — indentation, naming, patterns.
3. Add JSDoc to public functions. Use TypeScript strict types.
4. Handle errors explicitly — no silent swallows, no bare `catch {}`.
5. Add timeouts to external I/O calls.
6. Do NOT refactor unrelated code unless explicitly asked.

### Phase 4: Test
1. Run existing tests to ensure nothing is broken: `pnpm test`.
2. If new behavior was added, write tests that prove it works.
3. Tests must cover: happy path, error case, edge case.
4. Use real calls where possible (vitest, no mocks for LLM tests).

### Phase 5: Verify
1. Run `pnpm build` to confirm TypeScript compiles cleanly.
2. Run `pnpm test` to confirm all tests pass.
3. List every file modified and summarize each change.
4. Identify the most likely failure point in the new code.

## Examples
**Input:** "Add a health check endpoint to the API"
**Workflow:** Read index.ts and Fastify setup → Plan: add GET /health route → Implement the route → Write test → Verify build + tests pass.

**Input:** "Fix the timeout error in shell execution"
**Workflow:** Read capabilities/shell.ts → Find the timeout logic → Identify the bug → Fix it → Run existing tests → Verify.

## Edge Cases
- If tests fail after the change, fix the issue before reporting success.
- If the build fails with type errors, resolve them — do not skip with `any`.
- If the task requires a dependency, check package.json first; install only if truly needed.
- If the user's request is vague, ask for clarification rather than guessing.
- Never claim "this should work" without running build and tests.
