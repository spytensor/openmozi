# Execution Event Protocol (`execution_v1`)

This document defines how MOZI exposes tool execution progress across channels in a consistent, architecture-level way.

## Goals

- Make execution observable in-chat (not only in diagnostics/workspace panels).
- Keep channel adapters thin and standardized.
- Support capability-based evolution without breaking old clients.

## Scope

`execution_v1` currently applies to WebSocket channels (Web UI).
Telegram and other channels can render equivalent information with their own transport, but should follow the same lifecycle semantics.

## Event Lifecycle

Each tool call emits two logical events:

1. `start` (`status = running`)
2. `end` (`status = success | error`)

Correlation is done by `callId` when available, with tool-name fallback for legacy cases.
At architecture level, events should carry:

- `turnId`: one user request lifecycle
- `taskId`: owning task (explicit DAG task or synthetic simple-task id)

## Wire Format (WebSocket)

Message type: `tool_event`

```json
{
  "type": "tool_event",
  "phase": "start",
  "tool": "web_search",
  "callId": "call_abc123",
  "taskId": "task_1",
  "turnId": "turn_1771829000000_ab12cd",
  "status": "running",
  "timestamp": 1771828000000
}
```

```json
{
  "type": "tool_event",
  "phase": "end",
  "tool": "web_search",
  "callId": "call_abc123",
  "taskId": "task_1",
  "turnId": "turn_1771829000000_ab12cd",
  "status": "error",
  "error": "SEARCH1API_KEY environment variable is not set",
  "timestamp": 1771828001200
}
```

Field rules:

- `type`: fixed string `tool_event`
- `phase`: `start` or `end`
- `tool`: tool name (required)
- `callId`: optional but strongly recommended; sourced from model tool call id
- `taskId`: optional but recommended; task-level ownership
- `turnId`: optional but recommended; request-level ownership
- `status`: `running`, `success`, `error`
- `error`: optional, only for `status = error` (trimmed)
- `timestamp`: server event time (ms)

## Capability Negotiation

Clients must opt in via hello capabilities:

- `execution_v1`

If not present, server does not send `tool_event` frames to that client.
This keeps older clients compatible.

## Routing and Isolation

Execution events are scoped by `chatId`:

- server emits progress with `chatId`
- WebSocket broadcaster only delivers to connections mapped to that chat/user

This prevents cross-session execution leakage.

## Emission Points

Execution events are emitted from:

- Gateway simple-loop tool execution
- DAG executor tool execution

Both emit:

- `tool_call` with `toolCallId` + `chatId`
- `tool_result` with `toolCallId` + `chatId` + optional `error`

WebSocket adapter translates these internal progress events into `tool_event`.

## UI Rendering Contract

Web UI chat timeline behavior:

- Group task/tool events by `turnId` as one execution block.
- On `tool_event(start)`: create or update a running tool row.
- On `tool_event(end)`: update same row to success/error.
- If `callId` missing, match latest running row with same tool name in the same turn.
- Legacy persisted `workspace_hub_v1` artifacts still suppress duplicate rows
  when restored. There is no current producer; new execution artifacts use the
  live file/task event paths.

This yields Claude Code / Codex-like "what MOZI is doing now" visibility.

## Live Work Surface

`artifact_v1` clients may receive a running artifact before the tool has
finished. This is used for long-form documents, reports, code previews, and
other renderable work where the user should see the work surface update while
the model is still producing the artifact content.

Runtime source of truth:

- The LLM adapter forwards AI SDK `tool-input-start`, `tool-input-delta`, and
  `tool-input-end` events.
- The Brain only opens a live surface for renderable tools such as
  `create_artifact` or renderable `write_file` calls.
- The live surface patches only safe renderable fields (`title`,
  `content_type`, `code`, `path`, `content`) and never exposes arbitrary tool
  arguments.
- Completion still comes from the actual tool result. A running live artifact is
  patched to `completed` only after the underlying tool succeeds.

Wire format remains additive through existing artifact frames:

```json
{
  "type": "artifact_open",
  "artifact": {
    "id": "live_1771829000000_ab12cd",
    "plugin_id": "live_work_v1",
    "title": "Generating artifact",
    "status": "running",
    "fallback_text": "Preparing live preview...",
    "data": {
      "content_type": "markdown",
      "live_preview": true,
      "phase": "preparing",
      "meta": { "turn_id": "turn_1771829000000_ab12cd" }
    }
  }
}
```

```json
{
  "type": "artifact_patch",
  "artifactId": "live_1771829000000_ab12cd",
  "patch": {
    "status": "running",
    "fallback_text": "Writing document...",
    "data": {
      "content_type": "markdown",
      "markdown": "# Draft..."
    }
  }
}
```

The UI should render running live surfaces with an indeterminate activity
indicator unless the backend supplies a real bounded `progress` value. MOZI must
not invent percentages for model synthesis or artifact generation.

## Security and UX Policy

- Do not expose raw tool arguments by default.
- Keep error snippets bounded (short, user-actionable).
- Execution visibility should reduce anxiety, not dump telemetry noise.

## Versioning Strategy

- Additive evolution via capability flags (`execution_v2`, etc.).
- Never silently change `execution_v1` semantics.
- New channels should either:
  - implement equivalent execution lifecycle UX, or
  - explicitly fall back and hide unsupported execution details.

## Acceptance Checklist

- User sees tool start/end in chat while response is still being produced.
- No duplicate assistant final message due to execution events.
- No cross-chat event leakage.
- Old clients work without `execution_v1`.
