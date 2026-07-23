# Runtime Hardening Blueprint

## 1. Executive Summary

MOZI's repeated production failures have one common shape: soft model contracts crossed runtime seams without hard enforcement.
The highest-return fixes are small: richer validation errors, shared context builders, event persistence tests, and one E2E gate.
`ends_turn` is the right pattern: model-facing acknowledgement is not enough; the runtime must stop the loop.
Malformed tool args are still mostly handled by ad hoc `as string` checks, so repeated bad calls remain expensive and opaque.
Text-protocol tool recovery is useful but inherently variant-fragile; native tool calls should remain the default contract.
ToolContext is the riskiest seam because missing optional fields silently disable gates.
Progress, `event_log`, `session_timeline_events`, task transcripts, and plan-panel state are separate stores with no coverage proving write/read alignment.
Duplicated paths should be killed or contract-tested; especially approvals, delivery, and LLM call option construction.
Step execution and plan completion should use a configurable stronger model role.
Do not add an observability platform; add narrow runtime invariants that catch user-visible failures.

## 2. Workstream A: Soft-Contract Inventory

| Item | Evidence | Current class | Observed failure | Target class | Mechanism |
|---|---:|---|---|---|---|
| Decompose ack tells the model to stop but used to rely on compliance | `src/tools/task-tools.ts:253`, `src/tools/task-tools.ts:619`, `src/core/brain-engine.ts:1203` | enforced now | Double foreground execution after background plan start | enforced | Keep `ToolResult.ends_turn`; add tests for every future handoff tool. |
| Complexity hint tells model to call `decompose_task FIRST` | `src/core/brain-engine.ts:690` | hope | Decompose trigger reliability remains issue #73 per `IMPLEMENTATION.md:2020` | enforced/tolerant | Move from injected directive to runtime planner trigger or force-decompose E2E hook. |
| SOUL says "ALWAYS consider decomposition" and skill-before-decompose | `src/templates/SOUL.md:65` | hope | Workflow skill activation was 0/2 before prompt fix, per `IMPLEMENTATION.md:1946` | tolerant | Track missed use_skill/decompose opportunities in E2E, not just prompt text. |
| SOUL says tools first and verify before answer | `src/templates/SOUL.md:108`, `src/templates/SOUL.md:145` | hope | Freshness failure used training data when search absent, per `IMPLEMENTATION.md:1971` | enforced where currentness is requested | Tool registry truth plus answer-level freshness gate for "latest/recent". |
| Runtime Operation says only use available tools and do not invent readiness | `src/templates/SOUL.md:202` | hope | Constitution forbids invented capabilities at `docs/CONSTITUTION.md:85` | enforced | Capability manifest and dynamic registry must be source of prompt claims. |
| Web search error instructs model not to answer from training data | `src/tools/web-tools.ts:118`, `src/tools/web-tools.ts:125` | hope | Same freshness class as above | enforced | Return structured error category consumed by answer gate. |
| `create_artifact` description tells model not to downgrade Office files | `src/tools/runtime-tools.ts:165` | hope | Repeated invalid create_artifact args are unfixed; bad shape unknown | tolerant/enforced | Schema validation before execution with error echo of received keys and allowed keys. |
| `create_artifact` validation only checks truthy required values | `src/tools/runtime-tools.ts:521`, `src/tools/runtime-tools.ts:527` | tolerant but opaque | Invalid args 2-5 times in three plan runs | tolerant | Report `received_keys`, field types, and safe coercions; cascade-cancel after threshold remains. |
| `create_tool` validates manually and reports specific fields | `src/tools/runtime-tools.ts:347`, `src/tools/runtime-tools.ts:353` | tolerant | None observed | keep tolerant | Use as model for artifact validation detail. |
| DAG decomposition Zod schema validates subtasks | `src/core/dag-bridge.ts:26`, `src/core/dag-bridge.ts:39`, `src/core/dag-bridge.ts:263` | enforced | Prevents invalid dependencies and sizes | keep enforced | Keep Zod; expose validation error paths to model. |
| DAG plan semantic validation rejects forward deps and depth | `src/core/dag-bridge.ts:267` | enforced | None observed | keep enforced | Keep as runtime rule. |
| TEL router uses Zod param schemas | `src/tel/router.ts:14`, `src/tel/router.ts:126`, `src/tel/router.ts:226`, `src/tel/router.ts:239` | enforced | TEL path can reject malformed shell/fs intents | keep enforced | Prefer TEL-style Zod for system tools. |
| Tool executor parses JSON args once | `src/tools/executor.ts:642`, `src/tools/executor.ts:647` | enforced | Bad JSON returns exact invalid JSON | keep enforced | Add schema-name and tool-name fields to error result. |
| Permission gate skips if `permissionLevel` or `agentId` missing | `src/tools/executor.ts:655`, `src/tools/executor.ts:659` | hope at seams | DAG steps ran without permission fields; gates skipped | enforced | Require a normalized `ExecutionContext` for every surface or fail closed for gated tools. |
| L1 write confirmation skips non-interactive callers | `src/tools/executor.ts:678`, `src/tools/executor.ts:682` | hope | Background/plan contexts can bypass ask-before-write if fields absent | enforced by context class | Make "non-interactive allowed to skip" explicit per surface and test matrix. |
| Loop kernel injects truth/failure/loop hints | `src/core/unified-execution-kernel.ts:78`, `src/core/unified-execution-kernel.ts:198`, `src/core/unified-execution-kernel.ts:211` | mixed | Repeated bad tool args still happen until cascade stop | enforced for stop, hope for hints | Stop after threshold for DAG; keep hint-only only in interactive with telemetry. |
| Legacy parser rescues many text protocols | `src/core/legacy-tool-parsing.ts:1`, `src/core/legacy-tool-parsing.ts:235`, `src/core/legacy-tool-parsing.ts:256` | tolerant | DSML variants leaked as user text | tolerant but brittle | Keep parser, add provider-specific fixtures, and treat unrecovered DSML as empty response. |
| DSML fullwidth pipe support | `src/core/legacy-tool-parsing.ts:161`, `src/core/legacy-tool-parsing.ts:165` | tolerant | Fullwidth pipes needed a separate fix | keep tolerant with tests | Test ASCII, fullwidth, doubled-pipe variants. |
| Brain strips legacy markup before visible output | `src/core/brain-engine.ts:60`, `src/core/brain-engine.ts:67`, `src/core/brain-engine.ts:1367` | tolerant | Text-only recovery once shipped ignored-tool text | enforced fallback | Recovery calls should reject any DSML/tool markup as non-answer. |

## 3. Workstream B: Seam Audit

### ToolContext Matrix

| Field | Interactive brain loop | DAG in-process step | Subagent/worker | Background jobs | Recovery calls | Proactive engine |
|---|---|---|---|---|---|---|
| `chatId` | set at `src/gateway/handler.ts:581` | set/overridden at `src/core/dag-task-loop.ts:240` | metadata only at `src/core/subagent-dispatch.ts:264`; subagent tool context uses task id as chat id at `src/agents/subagent-policy.ts:72` | background task carries `chat_id` but LLM handler has no ToolContext at `src/background-executor/handlers/llm-background.ts:10` | not passed to self-heal chat options at `src/core/brain-engine.ts:1630` | no ToolContext in `src/core/proactive-engine.ts:476` |
| `tenantId` | set at `src/gateway/handler.ts:583` | set from task at `src/core/dag-task-loop.ts:244` | task tenant passed to worker at `src/core/subagent-dispatch.ts:256` | task tenant exists but LLM handler calls `getBrainClient()` without routing context at `src/background-executor/handlers/llm-background.ts:19` | not in recovery billing/options at `src/core/brain-engine.ts:1630` | config default route at `src/core/proactive-engine.ts:470` |
| `sessionId` | set at `src/gateway/handler.ts:587` | inherited/refreshes grants at `src/core/dag-task-loop.ts:390` | worker metadata only at `src/core/subagent-dispatch.ts:265`; subagent tool context lacks it at `src/agents/subagent-policy.ts:66` | absent | absent | absent |
| `userId` | set at `src/gateway/handler.ts:584` | inherited from plan context at `src/core/plan-runner.ts:85` | absent from subagent tool context at `src/agents/subagent-policy.ts:66` | absent | absent | absent |
| `permissionLevel` | set from session at `src/gateway/handler.ts:551` and `src/gateway/handler.ts:589` | plan context builds it at `src/core/plan-runner.ts:78`; task loop refreshes at `src/core/dag-task-loop.ts:390` | capped for task brief at `src/core/subagent-dispatch.ts:203`; subagent local context has only permission at `src/agents/subagent-policy.ts:70` | absent | absent | absent |
| `scopeGrants` | set at `src/gateway/handler.ts:592` | plan context and per-batch refresh at `src/core/plan-runner.ts:89`, `src/core/dag-task-loop.ts:393` | absent from subagent context | absent | absent | absent |
| `abortSignal` | set at `src/gateway/handler.ts:579`, `src/gateway/handler.ts:594` | set at `src/core/dag-task-loop.ts:246` | passed to worker at `src/core/subagent-dispatch.ts:270` | background handlers receive signal at `src/background-executor/handlers/llm-background.ts:10` | recovery lacks abort signal in chat options at `src/core/brain-engine.ts:1630` | absent |
| artifact plumbing | set via `onArtifact` at `src/gateway/handler.ts:593`; coordinator in `src/core/brain-engine.ts:726` | available only if base context carries it | absent | absent | absent | absent |
| elevation cache/write-confirmation state | shared object in brain loop at `src/core/brain-engine.ts:1130`; ToolContext fields at `src/tools/types.ts:86` | shared task context at `src/core/dag-task-loop.ts:236` | absent | absent | absent | absent |

Target: create one `buildExecutionToolContext(surface, inputs)` function and one contract test that asserts every surface either provides a field or explicitly marks it unsupported.

### Event Pipeline

| Pipeline | Writers | Readers | Gap |
|---|---|---|---|
| Progress bus | `emit` adds timestamp at `src/progress/event-bus.ts:163`; DAG emits tool/task events at `src/core/dag-task-loop.ts:373`, `src/core/dag-task-loop.ts:415` | Telegram bridge handles only ProgressEvent types at `src/progress/progress-bridge.ts:155`; WebSocket saves approval events at `src/channels/websocket.ts:1152` | No `dag_tool_loop_guard` progress type exists in `src/progress/event-bus.ts:16`, so guard stops are invisible in live UI. |
| `event_log` | `log` inserts at `src/store/events.ts:21`; task status writes at `src/store/task-dag.ts:268`; guard writes at `src/core/dag-task-loop.ts:88` | event learner reads at `src/core/event-learner.ts:54`; task inspect uses recent task events (`src/core/task-management.test.ts:103`) | Guard row is persisted only in `event_log`; plan panel does not read it. |
| `session_timeline_events` | `saveTimelineItem` upserts at `src/memory/session-timeline.ts:130`; WebSocket approval request save at `src/channels/websocket.ts:1168` | UI restores via `getSessionTimeline` at `src/memory/session-timeline.ts:172` | Guard events are never written here, so Web UI session restore cannot show them. |
| Task transcripts/results | DAG task loop appends transcript at `src/core/dag-task-loop.ts:434` and persists final result at `src/core/dag-task-loop.ts:499` | plan completion reads step results at `src/core/plan-runner.ts:337` | Guard stop returns fallback before final-result persist path; transcript may have error but plan summary only sees task status/output. |
| Plan panel | API state is tasks-table rooted; UI states this at `ui/src/components/chat/ExecutionPlanPanel.tsx:47` | `listPlanRootTasks` filters task rows at `src/store/task-dag.ts:237` | It cannot show guard reason unless task status metadata or timeline is updated. |

### Approval Flow Matrix

| Entry | Evidence | Request types/options | Gap |
|---|---:|---|---|
| WebSocket structured approve/reject | `src/channels/websocket.ts:376`, `src/channels/websocket.ts:389` | passes `grantScope` for `once`/`session` | Correct current path; keep contract test. |
| WebSocket slash-command fallback | `src/channels/websocket.ts:203`, `src/channels/websocket.ts:216` | converts scope to `/approve <id> <scope>` | Duplicates command parsing. |
| Slash command handler | `src/index.ts:643`, `src/index.ts:657` | parses `once`/`session` and passes `grantScope` | Correct now, but parallel to WS structured path. |
| ApprovalCard | `ui/src/components/chat/ApprovalCard.tsx:15`, `ui/src/components/chat/ApprovalCard.tsx:78` | scope buttons only for path/write grants | UI is appropriate; tests should assert payload includes scope. |
| Tool-created write confirmation | `src/tools/executor.ts:377`, `src/tools/executor.ts:418` | reads approved request context `grant_scope` | Depends on approval path preserving `grantScope`. |
| Shell approval retry | `src/tools/tool-utils.ts:337`, `src/tools/tool-utils.ts:348` | `approval_request_id` pattern | Different path than interactive wait; keep or fold behind same approval service. |

### Session State

Permission level is read at turn start (`src/gateway/handler.ts:551`), refreshed per DAG batch (`src/core/dag-task-loop.ts:390`), and persisted by the session permission module (`src/security/session-permissions.ts:17`). Scope grants are read at turn start (`src/gateway/handler.ts:592`) and per DAG batch (`src/core/dag-task-loop.ts:393`). Workspace root is turn-scoped context, injected after compression (`src/gateway/handler.ts:562`) and copied into ToolContext (`src/gateway/handler.ts:591`). Staleness windows remain for subagents and background jobs, which do not refresh session-derived fields.

## 4. Workstream C: Parallel-Path Inventory

| Mechanism | Paths and behavioral diff | Production bug caused | Recommendation |
|---|---|---|---|
| Approval resolution | WS structured path passes `grantScope` at `src/channels/websocket.ts:389`; slash fallback builds text at `src/channels/websocket.ts:216`; command handler parses at `src/index.ts:643` | WS dropped grant scope before #444/#445 class | Merge behind one `resolveApproval(requestId, actor, scope)` service; keep both transports as thin adapters. |
| DAG inline vs background | Background persists plan and starts detached at `src/core/dag-bridge.ts:286`; inline creates tasks and runs synchronously at `src/core/dag-bridge.ts:354` | Double-execution and turn-timeout fragility | Kill inline after one release, or keep only behind test-only flag. |
| Delivery | Brain saves assistant response at `src/gateway/handler.ts:615`; plan runtime delivers via `deliverAssistantMessage` at `src/core/plan-runner.ts:464`; progress report uses notifier at `src/tools/runtime-tools.ts:507` | User-visible truth can diverge by path | Centralize delivery envelope: source, session, turn, persistence, broadcast. |
| Permission gates | Executor preflight at `src/tools/executor.ts:655`; TEL router validation at `src/tel/router.ts:258`; fs path/scope checks in `src/tools/tool-utils.ts:123` | Missing ToolContext fields skipped executor gate | Single permission decision object passed through executor and TEL; fail closed when gated tool lacks context. |
| Artifact creation | `create_artifact` renders UI at `src/tools/runtime-tools.ts:521`; write-file auto artifacts are pre-opened in brain at `src/core/brain-engine.ts:250`; coordinator pre-open tracks streaming at `src/core/brain-engine.ts:381` | Invalid create_artifact args and Office downgrade risk | Keep multiple producers but one artifact schema validator/coordinator API. |
| LLM invocation | Brain stream/non-stream, DAG steps, plan summary, recovery, background jobs, and proactive wake cycles use explicit surface defaults; the retired brain-state extractor has no runtime call path | Keep think/timeouts/billing/model strength consistent | Maintain `defaultChatOptionsForSurface()` coverage for every live surface. |
| Subagent fallback | Managed worker path at `src/core/subagent-dispatch.ts:241`; process subagent path at `src/core/subagent-dispatch.ts:309`; in-process fallback at `src/core/dag-executor.ts:789` | Fallback can change permission/context semantics | Keep with contract test proving result envelope, permission cap, and context fields. |

## 5. Workstream D: E2E Release Gate Design

Command: `pnpm gate:e2e`.

Run after container build with a disposable `MOZI_HOME`, SQLite DB, WebSocket UI API enabled, and Node 22. The gate sends one complex prompt through `/ws` that must force decomposition, create a background plan, execute two cheap deterministic steps, surface progress via `/api/sessions/:id/plans`, and deliver a final assistant message to the same session.

Options:

| Option | Design | Pros | Cons | Recommendation |
|---|---|---|---|---|
| Scripted/fake LLM via config/env | `MOZI_E2E_LLM_SCRIPT=...` returns native tool calls and final text deterministically | Fast, cheap, catches runtime seams | Less provider realism | Primary CI gate. |
| Cheap real model with forced-decompose hook | Real model, but prompt/config forces `decompose_task` | Catches provider tool-call quirks | Cost/flakiness | Nightly/manual gate. |
| Hybrid | Scripted gate in PR; real-model probe post-merge or release candidate | Balances cost and realism | Two modes to maintain | Use hybrid. |

Assertions:

1. `decompose_task` tool call produces a root task tagged `plan:root` (`src/store/task-dag.ts:230`).
2. `ToolResult.ends_turn` stops foreground loop (`src/tools/types.ts:26`, `src/core/brain-engine.ts:1207`).
3. Plan root and children persist; panel API returns status from tasks table (`ui/src/components/chat/ExecutionPlanPanel.tsx:47`).
4. Progress bus emits task/tool events with session/tenant (`src/core/dag-task-loop.ts:373`, `src/core/dag-task-loop.ts:415`).
5. Invalid tool args fixture triggers repeated-failure guard and persists a visible guard reason.
6. Final delivery is via runtime `deliverAssistantMessage` (`src/core/plan-runner.ts:464`), not model-written foreground text.
7. `event_log`, `session_timeline_events`, task transcript, and conversation row agree on task/session IDs.

Budget: scripted CI under 90 seconds; real-model mode under 5 minutes and $0.25. It would have caught: decompose double-execution, missing ToolContext permission fields, context spread approval loss, WS grantScope loss, DSML text-only recovery if included as provider fixture, repeated create_artifact invalid args, plan panel invisibility, runtime delivery divergence, and background summary option drift.

## 6. Workstream E: Step-Model Routing Design

Current step routing already enters the role-slot system: `dag-task-loop.resolveClient` calls `getClientForTask` at `src/core/dag-task-loop.ts:176`, and `getClientForTask` selects through `selectModel` at `src/core/model-router.ts:320`. Existing roles include `simple_subagent`, `complex_subagent`, `summary`, and `brain` (`src/core/model-router.ts:430`, `src/core/model-router.ts:459`, `src/core/model-router.ts:485`).

Design:

```json
{
  "model_router": {
    "roles": {
      "step": { "provider": "anthropic", "model": "claude-sonnet-4-5", "think": "high" },
      "plan_summary": { "provider": "openai", "model": "gpt-4.1", "think": "low" }
    },
    "role_fallbacks": {
      "step": ["step", "complex_subagent", "brain"],
      "plan_summary": ["plan_summary", "summary", "brain"]
    }
  }
}
```

Implementation plan, not code here: map DAG step execution to role `step` instead of inferred subagent roles; map `summarizePlanCompletionWithBrain` to `plan_summary` instead of `ctx.fallbackClient` (`src/core/plan-runner.ts:393`). Reuse provider failover and entitlement context from `model-router.ts:236` and billing injection from `model-router.ts:392`. Cost note: unattended step loops are where weak-model retries burn the most time and tokens; stronger step routing should be opt-in per tenant with a fallback chain to brain.

## 7. Guard-Event Mystery: Root Cause and Fix

Local reproduction with Node 22 against compiled runtime and a temporary migrated DB:

```text
recordTaskLoopGuardEvent(task tenant_a, chat-1, repeated_tool_failures)
SELECT COUNT(*) FROM event_log -> 1
query('task', id) with default tenant -> []
query('task', id, 'tenant_a') -> dag_tool_loop_guard row
```

Root cause: `recordTaskLoopGuardEvent` itself does persist when the DB and tenant are correct (`src/core/dag-task-loop.ts:88`, `src/store/events.ts:21`). The "never appears" symptom is a read-path mismatch and visibility gap:

1. The guard is written only to `event_log` under `task.tenant_id` (`src/core/dag-task-loop.ts:104`).
2. Default event queries filter tenant `'default'` (`src/store/events.ts:33`, `src/store/events.ts:52`), so any tenant-specific run appears empty if inspected without tenant.
3. The Web UI/session restore reads `session_timeline_events`, not `event_log` (`src/memory/session-timeline.ts:172`).
4. The plan panel reads `tasks`, not `event_log` (`ui/src/components/chat/ExecutionPlanPanel.tsx:47`, `src/store/task-dag.ts:237`).
5. `ProgressEvent` has no guard event type (`src/progress/event-bus.ts:16`), and the bridge switch cannot render it (`src/progress/progress-bridge.ts:155`).

Fix: when a DAG guard fires, write the `event_log` row, emit a new `task_guarded`/`task_failed` progress event with reason, persist the reason in task status metadata, and append a transcript error. Add a vitest that initializes DB, calls `resetColumnsEnsured()`, forces the guard path, and asserts all four stores: `event_log`, timeline, task status metadata, transcript.

## 8. Remediation Waves

| Wave | Size | Items | Acceptance criteria | Sign-off |
|---|---|---|---|---|
| 1 | S | Add detailed schema errors for `create_artifact`; echo received keys/types; add repeated-invalid-args fixture. | Invalid artifact call returns `received_keys`; three repeated failures produce one guard event and cancelled plan. | Mechanical |
| 1 | S | Guard-event visibility fix. | Forced repeated-failure test sees `event_log`, timeline/task update, task transcript, and plan panel reason. | Mechanical |
| 1 | S | ToolContext builder and matrix tests for brain, DAG, subagent fallback, background. | Missing `permissionLevel`/`agentId` for gated tools fails closed or is explicitly unsupported. | Mechanical |
| 1 | S | Approval resolver contract test for WS structured, WS slash, command, ApprovalCard. | `grantScope=session` persists and suppresses second prompt in real executor test. | Mechanical |
| 2 | M | Centralize LLM surface options. | Snapshot tests cover role, think, timeout, execution_scope, billing for brain, DAG, summary, recovery, background. | Mechanical |
| 2 | M | Add scripted `pnpm gate:e2e`. | CI gate drives one complex prompt through plan creation, progress API, step execution, completion delivery. | Operator sign-off for runtime budget |
| 2 | M | Legacy parser fixture suite for DSML variants and no-tools recovery. | ASCII/fullwidth/doubled variants parse or are suppressed; no "ignored tool call" final answer. | Mechanical |
| 3 | M | Step-model and plan-summary routing roles. | Configured `step` role is used for DAG steps with fallback to brain; cost telemetry tagged by role. | Operator sign-off for cost |
| 3 | M | Kill or quarantine inline DAG mode. | No production config uses inline; inline is test-only or removed. | One-way-door design decision |
| 4 | L | Delivery envelope unification. | Brain, plan completion, progress report, proactive notifier share persistence/broadcast contract. | Operator sign-off |

## 9. What NOT To Do

Do not build a broad observability platform before fixing the seams above. The issue is not lack of dashboards; it is stores that are written and read by different paths without contract tests.

Do not add more prompt prose for behavior already known to fail. `ends_turn` shows the right direction: runtime enforcement beats model instructions.

Do not replace native tool calls with more text protocols. Keep tolerant recovery, but treat it as a compatibility layer with fixtures.

Do not add a new orchestration framework. The constitution says runtime owns execution (`docs/CONSTITUTION.md:56`) and release gates prove it (`docs/CONSTITUTION.md:130`); small local invariants are enough.

Do not optimize token cost by weakening schemas or hiding tools based on user-message keywords. The tool registration truthfulness approach in `IMPLEMENTATION.md:1957` is the safer pattern.
