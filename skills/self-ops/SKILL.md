---
name: self-ops
description: "Runtime self-diagnosis knowledge: database layout, observability APIs, timeout hierarchy, restart procedure, failure replay. Use when the user asks to debug this runtime itself — inspect its database, traces, prompt snapshots, timeouts, service health, or configuration."
version: "1.0.0"
category: system
user-invocable: true
requires:
  bins: []
  env: []
metadata:
  priority: 50
---

# Runtime Self-Ops

Knowledge for diagnosing and operating this runtime. Verify claims with tools
before reporting — never say "database is empty" without querying it.

## Database
- Location: `~/.mozi/data/mozi.db` (SQLite, WAL mode). But do not assume
  `~/.mozi` is the active home — check `/api/health` for the real `mozi_home`.
- Inspect: `shell_exec('sqlite3 ~/.mozi/data/mozi.db ".tables"')`.
- Key tables: `skill_versions`, `agent_registry`, `memory_facts`,
  `conversations`, `tasks`, `event_log`, `turn_traces`, `tool_spans`,
  `prompt_snapshots`, `system_state`.
- Startup sequence: config load → DB init → migrations → bootstrap →
  workspace skills → channels. Schema evolution must stay additive for
  legacy DBs.

## Observability
- Every turn has a persistent `trace_id` in `turn_traces`; each tool call
  writes a span in `tool_spans`.
- Prompt snapshots are captured per turn into `prompt_snapshots` (context
  slot breakdown, tool set, token budgets) and auto-pruned.
- Dashboard APIs: `/api/dashboard/models` for model dimensions;
  `/api/dashboard/slo?period=day|week|month&tenantId=...&model=...` for
  success rate, latency, failure categories, cost, and recent traces/spans.
- The failure replay harness can export a fixture by `trace_id` and generate
  a regression test skeleton.
- Anchor reliability explanations to concrete trace IDs and span failures,
  not generic summaries.

## Timeout Hierarchy
Timeouts are nested; inner fires before outer:
- Tool SLA: per-tool execution timeout (default 60s, `tel.tools`).
- LLM call: single inference timeout (`tools.loops.llm_call_timeout_ms`,
  default 300s). For CLI-pipe providers this covers the full agent turn.
- Turn timeout: end-to-end loop runtime per turn
  (`tools.loops.max_elapsed_ms`, default 600s), checked between iterations.
- Channel timeout: channel-level guard (e.g.
  `telegram.interactive_turn_timeout_ms`, default 600s).

## Process Management
- Restart ONLY via the `restart_self` tool. NEVER via `shell_exec` with
  `pnpm mozi stop/start/restart` — that kills your own process and leaves
  the runtime offline.
- Runtime service state: `/api/runtime/service` for installed/enabled/active
  status. Do not infer always-on behavior from the presence of a plist/unit
  path.
- Token budgets are model-aware and auto-compact at watermarks; oversized
  output requests are clamped before dispatch.

## Reading Own Source
- Source code (read-only) lives under the runtime project root; workspace is
  the read-write area. Never confuse them.
- To change own code: copy the file to workspace, edit there, then apply back
  with shell_exec (`cp` / `git`).
