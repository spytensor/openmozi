# SKILL.md Specification

## Overview

Skills are instruction assets — markdown files with YAML frontmatter that tell MOZI how to handle specific types of tasks. They are NOT executable code; the LLM follows the instructions using its available tools.

## File Location

```
skills/<name>/SKILL.md          # Bundled skills (shipped with MOZI)
~/.mozi/workspace/skills/<name>/SKILL.md  # User workspace skills
```

## Format

```markdown
---
name: "skill-name"
description: "One-line description of what this skill does"
version: "1.0.0"
category: "utility"           # utility | coding | research | communication | media | system
user-invocable: false         # Can users explicitly invoke this skill?
disable-model-invocation: false  # Prevent LLM from auto-activating?
always: false                 # Always inject into context?
requires:
  bins: [curl, python3]       # ALL must exist on PATH
  anyBins: [ffmpeg, avconv]   # AT LEAST ONE must exist
  env: [API_KEY]              # ALL env vars must be set
install:
  - kind: brew                # brew | npm | pip | manual
    formula: curl
    imports: []               # exact Python/Node module names this package provides
    bins: [curl]              # exact binaries this dependency provides
metadata:
  emoji: "🔧"
  priority: 50                # Lower = injected earlier (default 50)
  channels: ["telegram", "websocket"]  # Channel filter (empty = all)
---

# Skill Name

## When to Use
Describe the conditions under which this skill should activate.

## How to Execute
Step-by-step instructions for the LLM to follow.

## Examples
Concrete input/output examples.

## Edge Cases
Boundary conditions and error handling.
```

## Required Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique skill identifier |
| `description` | string | Yes | One-line description |

## Optional Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `version` | string | `"1.0.0"` | Semantic version |
| `category` | string | — | Skill category for grouping |
| `user-invocable` | boolean | `false` | Listed in `/skills` command |
| `disable-model-invocation` | boolean | `false` | Prevent auto-activation |
| `always` | boolean | `false` | Always inject into context |
| `requires.bins` | string[] | `[]` | Required binaries (ALL must exist) |
| `requires.anyBins` | string[] | `[]` | Required binaries (ANY must exist) |
| `requires.env` | string[] | `[]` | Required environment variables |
| `metadata.emoji` | string | — | Display emoji |
| `metadata.priority` | number | `50` | Injection priority |
| `metadata.channels` | string[] | all | Channel filter |
| `origin` | string | — | Provenance tag. `"autogen"` marks skills persisted by Brain-driven `propose_skill` (#258); autogen skills are excluded from `/skills` and `/api/skills` listings until an operator promotes them. |
| `source_task_id` | string | — | Originating task id for audit trails (written by `propose_skill`). |
| `metadata.sandbox_profile` | string | — | `"read-only"` \| `"workspace-write"` \| …  Default sandbox lane for this skill when executed. Autogen skills default to `read-only` (§7 Managed Worker Contract). |

### Dependency declarations

`install` is an executable runtime contract, not documentation. Pip/npm entries
must declare exact `imports` when failure recovery should be able to provision
them automatically. Brew/manual entries should declare exact `bins`. MOZI only
recovers dependencies named by these declarations; it never derives a package
name from untrusted error output. Pip/npm packages are installed into MOZI's
persistent managed runtime and verified before being reported ready. Brew and
manual actions are surfaced explicitly and are never auto-run.

## Skill Selection

Skill activation follows one authoritative path:

1. `always: true` skills are injected automatically.
2. Other eligible skills appear in the compact catalog; the Brain activates an
   applicable workflow with `use_skill` before executing it. An explicit user
   name is a strong selection cue, not a hidden keyword router.
3. If execution exposes an exact missing import/module/binary/env key, the
   runtime may recover only through a matching declaration in this manifest.
4. Infrastructure does not keyword-route workflow instructions behind the
   Brain's back. Runtime code owns readiness/provisioning; the Brain owns which
   workflow applies.

## Creating a New Skill

1. Create directory: `~/.mozi/workspace/skills/my-skill/`
2. Create `SKILL.md` with frontmatter + instructions
3. Run `reload_skills` or restart MOZI
4. Verify with `list_runtime_skills`

Or use the `skill-creator` bundled skill for guided creation.

## Best Practices

- Keep instructions actionable — the LLM follows them literally
- Include concrete examples with expected inputs/outputs
- Handle edge cases (missing data, errors, empty results)
- Keep each skill focused on ONE task type
- Test by sending a message that should trigger the skill
