---
name: skill-authoring
description: "How to install a skill package a user hands over (.skill/.zip/.tar.gz), and how to write a new skill into this runtime so it is listed, enabled and usable. Use when the user says 安装这个技能/装一下这个 SKILL/install this skill, uploads a skill package, or asks MOZI to 做一个技能/写一个 SKILL/把这个流程存成技能 — anything that ends with a skill living inside MOZI."
version: "1.0.0"
category: system
user-invocable: true
requires:
  bins: []
  env: []
metadata:
  priority: 60
---

# Skill authoring and installation

This is MOZI's own runtime contract for skills. It is not the same as
Claude Code's — `skill-creator` in this catalog is Anthropic's asset and
describes `.claude/` conventions and a `claude -p` eval loop that do not apply
here. Follow this skill for anything that has to end up installed in MOZI.

## Installing a package the user handed over

A skill package is an archive. `.skill` is the standard format (it is a zip);
users also send plain `.zip`, and it is common for the archive to contain the
`.skill` next to unrelated files they used while building it.

**Pass the archive straight to `install_skill`. Do not unpack it first.**

```
install_skill { "source": "path", "source_path": "<absolute path to the archive>" }
```

- Uploaded files arrive with their absolute path in your turn context. Use that
  path verbatim.
- `source: "path"` also accepts a directory containing `SKILL.md`, or the
  `SKILL.md` file itself.
- `source: "bundled"` is only for reinstalling a skill MOZI already ships. It
  is never the right choice for a user's package — it needs `skill_id`, and a
  user's skill has no bundled id.
- Add `"overwrite": true` only when replacing a skill of the same name.

The runtime unpacks the archive, finds `SKILL.md` (at the root, in a single
wrapper directory, or in a single nested `.skill`), copies it into the workspace
skill directory, and reloads the catalog. The result includes `eligible` and any
`missing_bins` / `missing_env`.

If it refuses, the message says why. Act on it rather than retrying:

| Message | What to do |
|---|---|
| `No SKILL.md found inside <file>` | Not a skill package. Look inside with `shell_exec` and tell the user what it actually contains. |
| `contains N skills` | Ask which one, then point `source_path` at that directory after unpacking. |
| `Workspace skill already exists` | Confirm with the user, then repeat with `"overwrite": true`. |
| `missing_bins` / `missing_env` non-empty | It installed but cannot run yet. Tell the user exactly which binary or key is missing. |

## Writing a new skill

When the user asks MOZI to turn a workflow into a skill:

1. **Write the files into a folder you can write** — the workspace, or beside
   the files this turn is already working with. A skill is a directory:

   ```
   <name>/
     SKILL.md          # required
     references/       # optional supporting docs
     scripts/          # optional executable helpers
   ```

2. **`SKILL.md` starts with YAML frontmatter.** `name` and `description` are
   required; everything else is optional:

   ```yaml
   ---
   name: weekly-pnl-brief
   description: "What it does, and — just as important — when it should trigger. Include the phrasings a user would actually type, in their language."
   version: "1.0.0"
   category: utility        # utility | coding | research | communication | media | system
   user-invocable: true     # false = model-only, not callable by name
   requires:
     bins: [python3]        # checked at load; missing ones make the skill ineligible
     env: [SOME_API_KEY]
   ---
   ```

   The body below the frontmatter is the procedure, and it is what gets loaded
   into context when the skill activates. Write it as steps, not prose.

3. **Install it** — this is the step that makes it real:

   ```
   install_skill { "source": "path", "source_path": "<the folder you just wrote>" }
   ```

   Installing copies the folder into the workspace skill directory and refreshes
   the catalog. Writing `SKILL.md` somewhere and stopping does *not* install
   anything.

4. **Confirm before you report success.** Call `list_runtime_skills` (or
   `validate_skill`) and check the skill is listed, enabled and eligible. Report
   what the runtime returned, not what you intended.

`description` decides whether the skill is ever used again: it is the only line
in the catalog, so it must carry both what the skill does and when to reach for
it. A description that only says what it does will never trigger.

## Two things that are not this

- **`propose_skill`** persists a draft into the autogen namespace with
  `user-invocable: false`. It is for a workflow *you* judged reusable
  mid-task — not for a skill the user asked you to make. Autogen drafts are
  hidden from the operator's Skills page, so a user who asked for a skill would
  see nothing there.
- **Editing an installed skill** is `install_skill` with `"overwrite": true`, or
  the operator editing `SKILL.md` on the Skills page. Do not hand-patch files
  under the workspace skill directory and assume the catalog noticed; call
  `reload_skills` if you do.
