# Welcome to MOZI

MOZI is your autonomous agent operating system. Here's what's available:

## Skills
Use `/skills` to list the bundled and workspace skills currently available.

## Pre-installed Agents
- **coder** — Writes and debugs code (L2: shell + filesystem)
- **reviewer** — Reviews code changes (L0: read-only)
- **researcher** — Searches and synthesizes information (L0: read-only)

## Getting Started
1. Send a message to start a conversation
2. Use `/status` to check system health
3. Use `/tasks` to see active tasks
4. Use `/skills` to list available skills
5. Use `/config` to view/update configuration

## Prompt Layers
- System prompts update with each MOZI release.
- Your overrides belong in `workspace/SOUL.local.md`, `workspace/AGENTS.local.md`, and `workspace/USER.md`.

## Commands
- `/status` — System status
- `/tasks` — Task list
- `/skills` — Skill list
- `/config set <key> <value>` — Update config
- `/approve <id>` — Approve a pending request
- `/reject <id>` — Reject a pending request
- `/onboard` — Re-run bootstrap setup
