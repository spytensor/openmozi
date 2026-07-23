---
name: commit
description: "Smart commit: bump version, find related issues, commit with Co-authored-by, push. Use when the user says 'commit' or wants to finalize changes."
disable-model-invocation: true
---

# Smart Commit

When the user asks to commit, execute ALL of these steps:

## Step 1: Analyze Changes

```bash
git status
git diff --stat
git diff
git log --oneline -5
```

Understand what was changed and why.

## Step 2: Determine Version Bump

Read `package.json` to get the current version. Determine the bump type based on changes:

- **patch** (x.y.Z): bug fixes, minor tweaks
- **minor** (x.Y.0): new features, new commands, new modules
- **major** (X.0.0): breaking changes

Update the `"version"` field in `package.json`.

## Step 3: Find Related Issues

Check if there are open GitHub issues related to the changes:

```bash
gh issue list --state open --limit 20
```

Match the changes against issue titles/descriptions. If a related issue is found, reference it in the commit message as `(#N)` and close it after pushing.

If `$ARGUMENTS` contains an issue number, use that directly.

## Step 4: Build & Test

```bash
pnpm build
pnpm test
```

If either fails, fix the issues before committing. Do NOT commit broken code.

## Step 5: Commit

Stage the changed files (be specific, avoid `git add -A` for safety):

```bash
git add <specific files>
git commit -m "<type>: <description> (#<issue>)

Co-authored-by: Mozi <MoziAI-co@users.noreply.github.com>"
```

Commit type: `feat:` for features, `fix:` for bugs, `refactor:` for refactors, `chore:` for config/deps.

## Step 6: Push

```bash
git push origin main
```

## Step 7: Close Related Issues

If a related issue was found:

```bash
gh issue close <N> --comment "Implemented in <commit-hash> (v<new-version>)."
```

## Step 8: Report

Print a summary:
- Version: old -> new
- Commit: hash
- Files changed: count
- Issue closed: #N (if any)
