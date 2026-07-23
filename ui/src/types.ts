import type { WorkspaceMessageContext } from "@/types/runtime";

export type AppView = "chat" | "scheduled" | "skills" | "memory" | "settings" | "admin" | "files";

export type ConnectionStatus = "connected" | "connecting" | "disconnected";

export type SessionState = "IDLE" | "WORKING" | "RESPONDING";

export interface ContextCompressionState {
  sessionId: string;
  stage: "preparing" | "summarizing" | "saving" | "completed" | "failed";
  sourceTokens: number;
  summaryTokens?: number;
  contextWindow: number;
  timestamp?: number;
  error?: string | null;
}

export interface Session {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
  last_message?: string;
  message_count?: number;
  workspace_root_id?: string | null;
  workspace_context?: WorkspaceMessageContext | null;
  project_root_id?: string | null;
  project_context?: WorkspaceMessageContext | null;
  execution_root_id?: string | null;
  execution_context?: WorkspaceMessageContext | null;
  activity_status?: "running" | "awaiting_approval" | null;
  activity_started_at?: number | null;
}

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  turnId?: string;
  /** Durable per-turn monotonic sequence (Issue #627); server-assigned. */
  seq?: number;
  streaming?: boolean;
  requestId?: string;
  /** Files the user attached to this message, shown as chips in the bubble. */
  attachments?: UploadedAttachment[];
}

export interface UploadedAttachment {
  filename: string;
  path: string;
  size?: number;
  mimeType?: string;
}

/** One web source a tool consulted (search hit or fetched page). */
export interface ToolSourceRef {
  title?: string;
  url: string;
  snippet?: string;
}

export interface ToolEvent {
  id: string;
  callId: string;
  taskId?: string;
  turnId?: string;
  seq?: number;
  agentId?: string;
  tool: string;
  phase: "start" | "end";
  status?: "success" | "error";
  intent?: string;
  result?: string;
  /** Web sources the tool consulted (end frames of search/fetch tools). */
  sources?: ToolSourceRef[];
  error?: string;
  elapsed_ms?: number;
  skillName?: string;
  skillDescription?: string;
  skillLoadOutcome?: "success" | "not_found" | "ineligible";
  skillMissingBins?: string[];
  skillMissingEnv?: string[];
  skillLoadError?: string;
  timestamp: number;
}

export interface TaskUpdate {
  id: string;
  task_id: string;
  /** Owning parent task id for nested task-timeline grouping (Issue #624). */
  parentTaskId?: string;
  jobId?: string;
  turnId?: string;
  seq?: number;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
  progress?: number;
  userStatus?:
    | "received"
    | "planning"
    | "responding"
    | "checking"
    | "starting"
    | "working"
    | "verifying"
    | "done"
    | "blocked";
  detail?: string;
  rawStatus?: string;
  runtimeLabel?: string;
  adapterId?: string;
  lane?: string;
  sandboxProfile?: string;
  heartbeat?: boolean;
  elapsed_ms?: number;
  timestamp: number;
}

/**
 * Typed plan presentation event (Issue #735): the plan's structure as data,
 * mirrored from the server's `plan_started` timeline item. The single source
 * the Working Card, sticky capsule, and Inspector render plan phases from —
 * never re-parsed from assistant prose.
 */
export interface PlanStartedUpdate {
  plan_id: string;
  goal: string;
  phases: Array<{ taskId: string; title: string; dependsOn: string[] }>;
  locale?: string;
  timestamp: number;
  turnId?: string;
  seq?: number;
}

export interface ApprovalRequest {
  id: string;
  description: string;
  action?: string;
  status: "pending" | "approved" | "rejected";
  timestamp: number;
  turnId?: string;
  seq?: number;
  required_level?: string;
  current_level?: string;
  denied_action?: string;
  tool?: string;
  tool_intent?: string;
  originating_prompt?: string;
}

export interface Artifact {
  id: string;
  plugin_id?: string;
  title: string;
  status: string;
  fallback_text?: string;
  data: ArtifactData;
  timestamp: number;
  turnId?: string;
  seq?: number;
}

export interface MemoryUpdate {
  count: number;
  added: number;
  reinforced: number;
  updated: number;
  factIds: number[];
  timestamp: number;
  turnId?: string;
  seq?: number;
}

export interface FileArtifactData {
  path: string;
  filename: string;
  ext?: string;
  size?: number;
  mime?: string;
  kind?: string;
  previewable?: boolean;
  previewUrl?: string;
  downloadUrl?: string;
}

export type ArtifactData = Record<string, unknown> & Partial<FileArtifactData>;

export interface TimelineItem {
  eventId?: number;
  type: "message" | "tool_event" | "task_update" | "plan_started" | "approval_request" | "artifact" | "memory_update";
  timestamp: number;
  /** Owning turn id (Issue #627); server-authoritative, undefined for legacy rows. */
  turnId?: string;
  /** Durable per-turn monotonic sequence (Issue #627); undefined for legacy rows. */
  seq?: number;
  data: ChatMessage | ToolEvent | TaskUpdate | PlanStartedUpdate | ApprovalRequest | Artifact | MemoryUpdate;
}

/** Turn origin/status vocabulary (Issue #627), mirrored from the server. */
export type TurnOrigin = "user" | "system" | "proactive" | "background" | "scheduler";
export type TurnStatus =
  | "active"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Server-authoritative Turn Envelope, returned by the timeline restore API. */
export interface TurnEnvelope {
  turnId: string;
  sessionId: string;
  chatId: string;
  origin: TurnOrigin;
  status: TurnStatus;
  seqHighWater: number;
  /**
   * Presentation locale carried from the server (Issue #628). Consumers read
   * this instead of scanning message characters. Absent for legacy turns and
   * turns with no reliable language signal.
   */
  locale?: string;
  startedAt: number;
  endedAt?: number;
}

// WS inbound
export type WSInboundMessage =
  | { type: "message"; role: MessageRole; content: string; turnId?: string; seq?: number; sessionId?: string }
  | { type: "stream_start"; requestId: string; turnId?: string; seq?: number; sessionId?: string }
  | { type: "stream_chunk"; requestId: string; content: string; turnId?: string; seq?: number; sessionId?: string }
  | { type: "stream_end"; requestId: string; content: string; turnId?: string; seq?: number; sessionId?: string }
  | { type: "tool_event"; phase: "start" | "end"; tool: string; status?: string; intent?: string; result?: string; sources?: ToolSourceRef[]; error?: string; elapsed_ms?: number; callId: string; taskId?: string; turnId?: string; seq?: number; agentId?: string; skillName?: string; skillDescription?: string; skillLoadOutcome?: "success" | "not_found" | "ineligible"; skillMissingBins?: string[]; skillMissingEnv?: string[]; skillLoadError?: string; timestamp?: number; sessionId?: string }
  | { type: "task_update"; task_id: string; parentTaskId?: string; rawStatus?: string; title: string; status: string; progress?: number; detail?: string; turnId?: string; seq?: number; timestamp?: number }
  | { type: "task_progress"; task_id: string; parentTaskId?: string; jobId?: string; adapterId?: string; runtimeLabel?: string; rawStatus?: string; status: string; userStatus?: string; title: string; detail?: string; progress?: number; turnId?: string; seq?: number; lane?: string; sandboxProfile?: string; heartbeat?: boolean; elapsed_ms?: number; timestamp?: number; sessionId?: string }
  | { type: "plan_started"; plan_id: string; goal: string; phases: Array<{ taskId: string; title: string; dependsOn: string[] }>; locale?: string; turnId?: string; seq?: number; timestamp?: number; sessionId?: string }
  | { type: "approval_request"; id: string; description: string; action?: string; sessionId?: string; turnId?: string; seq?: number; required_level?: string; current_level?: string; denied_action?: string; tool?: string; tool_intent?: string; originating_prompt?: string; grant_scope?: "once" | "session" }
  | { type: "approval_resolved"; id: string; status: "approved" | "rejected"; action?: string; description?: string; sessionId?: string; turnId?: string; seq?: number; permission_level?: string; required_level?: string; current_level?: string; denied_action?: string; tool?: string; tool_intent?: string; originating_prompt?: string; grant_scope?: "once" | "session" }
  | { type: "error"; message: string; sessionId?: string }
  | { type: "session_update"; sessionId: string; title: string }
  | { type: "session_list_changed"; sessionId: string }
  | { type: "session_activity"; sessionId: string; status: "running" | "awaiting_approval" | null; startedAt?: number }
  | { type: "session_selected"; sessionId: string | null }
  | { type: "session_bound"; sessionId: string }
  | { type: "welcome"; username: string; model: string; capabilities?: string[] }
  | { type: "artifact_open"; artifact: { id: string; plugin_id?: string; title: string; status: string; fallback_text?: string; data: Record<string, unknown> }; sessionId?: string; turnId?: string; seq?: number }
  | { type: "artifact_patch"; artifactId: string; patch: Record<string, unknown>; sessionId?: string; turnId?: string; seq?: number }
  | { type: "artifact_close"; artifactId: string; sessionId?: string; turnId?: string; seq?: number }
  | { type: "active_turn"; turnId: string | null; sessionId?: string; startedAt?: number; locale?: string }
  | { type: "turn_envelope"; turn: TurnEnvelope }
  | { type: "context_compression"; sessionId: string; stage: ContextCompressionState["stage"]; sourceTokens: number; summaryTokens?: number; contextWindow: number; timestamp?: number }
  | { type: "memory_update"; count: number; added: number; reinforced: number; updated: number; factIds: number[]; sessionId?: string; turnId?: string; seq?: number; timestamp?: number }
  | { type: "turn_queue"; status?: string; queueDepth?: number; reason?: string; sessionId?: string; timestamp?: number }
  | { type: string; [key: string]: unknown }; // workspace_* etc.

// WS outbound
export type WSOutboundMessage =
  | { type: "hello"; client: string; capabilities: string[] }
  | { type: "select_session"; sessionId?: string }
  | { type: "message"; content: string; sessionId?: string; workspaceContext?: WorkspaceMessageContext; attachments?: Array<Pick<UploadedAttachment, "filename" | "path">>; regenerate?: boolean }
  | { type: "cancel_turn"; sessionId?: string; turnId?: string }
  | { type: "approve"; id: string; sessionId?: string }
  | { type: "reject"; id: string; sessionId?: string }
  | { type: "ping" }
  | { type: "subscribe_workspace" }
  | { type: "unsubscribe_workspace" };
