import type { LLMClient } from '../core/llm.js';
import type { ExecutionModelSnapshot } from '../core/execution-model.js';
import type { ApprovalRequest } from '../security/gates.js';

export interface RepoInspectionState {
  enabled: boolean;
  groundedPaths: Set<string>;
  groundedDirectories: Set<string>;
  lastReadFilePath?: string;
}

/** One web source a tool consulted (search hit or fetched page). */
export interface ToolSourceRef {
  /** Page title when the provider returned one. */
  title?: string;
  url: string;
  /** Short provider snippet for source-list previews. */
  snippet?: string;
}

/** Result of executing a tool call */
export interface ToolResult {
  tool_call_id: string;
  tool_name?: string;
  content: string;
  is_error: boolean;
  /** Structured metadata for use_skill activations. */
  skillName?: string;
  skillDescription?: string;
  skillLoadOutcome?: 'success' | 'not_found' | 'ineligible';
  skillMissingBins?: string[];
  skillMissingEnv?: string[];
  skillLoadError?: string;
  /** Web sources this call consulted, for the UI source list (search/fetch tools). */
  sources?: ToolSourceRef[];
  /** Optional file path to send to the user (e.g. from write_file) */
  file_path?: string;
  /** Structured accessible files produced by this execution surface. */
  produced_files?: string[];
  /** A terminal rich artifact was emitted for this file mutation. */
  artifact_verified?: boolean;
  /** Runtime-enforced turn handoff: after this result the brain loop must
   *  finalize the turn (e.g. decompose_task started a detached background
   *  plan — the foreground yields instead of racing it). */
  ends_turn?: boolean;
  /** User-facing final message for an ends_turn result (the `content` field
   *  stays model-directed). */
  ends_turn_message?: string;
  /** Root plan identity when an ends_turn handoff started a detached DAG. */
  detached_plan_root_id?: string;
  /** Tool execution start timestamp (ISO) */
  started_at?: string;
  /** Tool execution end timestamp (ISO) */
  ended_at?: string;
  /** Tool execution duration in milliseconds */
  duration_ms?: number;
}

export interface ArtifactHint {
  artifactId: string;
  contentType?: string;
  title?: string;
  preopened?: boolean;
  toolName?: string;
  path?: string;
  adoptedByToolCallId?: string;
}

/** Optional context passed to tool execution */
export interface ToolContext {
  chatId?: string;
  channelType?: string;
  taskId?: string;
  tenantId?: string;
  userId?: string;
  agentId?: string;
  permissionLevel?: string;
  checkpointFailurePolicy?: 'rollback' | 'none';
  allowedPaths?: string[];
  client?: LLMClient;
  /** Model selected for this user turn. Detached work inherits this snapshot
   * unless the operator explicitly configured a step/summary override. */
  executionModel?: ExecutionModelSnapshot;
  /** Stable MOZI identity/runtime contract for delegated execution. Excludes
   * USER.md, channel adaptation, conversation history, and compiled memory. */
  systemPrompt?: string;
  /** Exact runtime-owned acceptance request when no visible user row exists. */
  originalRequest?: string;
  /** Caller-owned delivery is used by managed scheduled executions. */
  planDeliveryMode?: 'direct' | 'caller';
  /** Runtime origin inherited by a detached plan turn. */
  turnOrigin?: import('../core/turn-envelope.js').TurnOrigin;
  turnId?: string;
  /** Current Brain tool-loop iteration, set per batch for tool-span telemetry. */
  loopIteration?: number;
  /** True when the gateway opened a turn trace for this turnId — gates tool-span
   *  recording so non-traced paths (subagents, tests) don't hit the FK. */
  telemetryTraceActive?: boolean;
  useSubAgents?: boolean;
  subagentRuntimeSource?: string;
  subagentSessionKey?: string;
  abortSignal?: AbortSignal;
  /** Active granted project/workspace root for turn-scoped file artifact scans.
   *  When set, filesystem WRITES are restricted to this root (+ output dir and
   *  any per-session scope grants); reads stay unrestricted. */
  workspaceRootPath?: string;
  /** Extra directories the user granted write access to for THIS session
   *  (out-of-project-scope escalations). */
  scopeGrants?: string[];
  repoInspection?: RepoInspectionState;
  /** DB session ID for persisting artifacts */
  sessionId?: string;
  /** Exact user prompt that started this tool turn, used for approval reruns. */
  userPrompt?: string;
  /** Turn-local cache for permission elevation approvals. */
  permissionElevationRequests?: Map<string, ApprovalRequest>;
  /** True when the user approved a permission elevation to L1+ this turn.
   *  Prevents the L1 write-confirmation gate from firing again after elevation. */
  writeConfirmedByElevation?: boolean;
  /** A single approved elevated tool call. Never persisted or reused by later calls. */
  oneShotPermissionGrant?: { toolCallId: string; permissionLevel: string; previousPermissionLevel?: string; approvalRequestId: string };
  /** Suppresses the L1 write prompt only for its already-approved tool call. */
  oneShotWriteConfirmedToolCallId?: string;
  /** Renderable artifact IDs pre-opened for tool calls, keyed by tool_call_id. */
  artifactHints?: Map<string, ArtifactHint>;
  /** Realpath-resolved files already surfaced as rich artifacts in this turn. */
  turnRichArtifactPaths?: Set<string>;
  /** Turn-scoped artifact lifecycle coordinator. */
  artifactCoordinator?: import('../artifacts/coordinator.js').ArtifactCoordinator;
  /** Callback to emit artifact events (open/patch/close) to the UI */
  onArtifact?: (event: import('../artifacts/types.js').ArtifactEvent) => void;
  /** Execution-surface declaration for context fields intentionally not present. */
  executionContext?: {
    surface: string;
    unsupported: Array<keyof ToolContext>;
  };
}

export interface FileCheckpointHandle {
  checkpointId: string;
  tenantId: string;
  taskId: string;
  stepIndex: number;
  paths: string[];
}
