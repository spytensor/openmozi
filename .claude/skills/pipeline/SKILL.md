---
name: pipeline
description: "Full development pipeline: create GitHub issue, plan, implement with agent team, verify (build+test), commit, push, close issue. Use when you need to implement a feature or fix end-to-end."
disable-model-invocation: true
---

# Development Pipeline

Automate the full development lifecycle for a feature or fix described by `$ARGUMENTS`.

## Workflow

Execute these steps in order. Stop and report if any step fails.

### Step 1: Create GitHub Issue

```bash
gh issue create --title "<concise title from $ARGUMENTS>" --body "<detailed description>"
```

Parse the returned URL to extract the issue number. Print it.

### Step 2: Plan

- Research the codebase to understand what files need changing
- Design the implementation approach
- Identify all files to modify/create
- Write the plan to a file at `.claude/plans/<issue-number>.md`

### Step 3: Build Agent Team & Implement

- Use `TeamCreate` to create a team named after the issue
- Break the plan into independent tasks using `TaskCreate`
- Spawn agents in parallel using the `Task` tool with `team_name` parameter:
  - Each agent handles one task (one file or one concern)
  - Use `subagent_type: "general-purpose"` with `mode: "bypassPermissions"`
  - Run agents in background when possible
- Wait for all agents to complete by checking `TaskList`

### Step 4: Review

- Read the modified files to verify changes are correct
- Check for obvious issues, missing imports, type errors

### Step 5: Verify

Run build and tests:
```bash
pnpm build
pnpm test
```

If build or tests fail:
1. Read the error output
2. Fix the issues directly
3. Re-run verification
4. Repeat until passing

### Step 6: Commit & Push

```bash
git add <changed files>
git commit -m "feat: <description> (#<issue-number>)

Co-authored-by: Mozi <MoziAI-co@users.noreply.github.com>"
git push origin main
```

### Step 7: Close Issue

```bash
gh issue close <issue-number> --comment "Implemented in <commit-hash>."
```

### Step 8: Cleanup

- Shut down all team agents via `SendMessage` with `type: "shutdown_request"`
- Delete the team via `TeamDelete`
- Report final summary: issue number, commit hash, files changed, test results
