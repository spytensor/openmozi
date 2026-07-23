/**
 * Event Bus — single-process pub/sub for progress events.
 *
 * Used by Brain, Gateway, and channel adapters to communicate
 * real-time progress to the user without tight coupling.
 */

import { EventEmitter } from 'node:events';
import type { ToolSourceRef } from '../tools/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Progress event emitted during task execution */
export interface ProgressEvent {
  type:
    | 'dag_created'
    | 'plan_started'
    | 'task_started'
    | 'task_completed'
    | 'task_failed'
    | 'task_cancelled'
    | 'task_guarded'
    | 'tool_call'
    | 'tool_result'
    | 'tool_composing'
    | 'agent_spawned'
    | 'agent_completed'
    | 'agent_failed'
    | 'worker_status'
    | 'approval_request'
    | 'approval_resolved'
    | 'budget_warning'
    | 'context_compression'
    | 'overall_progress'
    | 'turn_state'
    /**
     * A turn's durable envelope changed and live clients should be handed the
     * new row. Carries no state of its own — the envelope in the store is the
     * truth. Separate from `turn_state` because that event also drives the
     * session FSM, which a concurrent background turn must not touch (#714).
     */
    | 'turn_envelope_updated'
    | 'session_activity_changed'
    | 'background_agent_complete'
    | 'background_agent_failed';
  taskId?: string;
  /**
   * For tool_composing: whether the model started or finished streaming the
   * tool call's arguments. Ephemeral presence signal — never persisted.
   */
  composingPhase?: 'start' | 'end';
  /**
   * Owning parent task id for nested task-timeline grouping (Issue #624). Set on
   * subtask lifecycle + delegated-worker events so a consumer can reconstruct the
   * plan → subtask tree; the plan root and top-level tasks leave this undefined.
   */
  parentTaskId?: string;
  taskTitle?: string;
  /**
   * For plan_started: the plan's ordered phases as typed data (Issue #735).
   * This — not formatted prose — is the presentation source for plan structure;
   * `taskId` carries the plan root and `taskTitle` the goal.
   */
  planPhases?: Array<{ taskId: string; title: string; dependsOn: string[] }>;
  /** For plan_started: presentation locale carried from the originating turn. */
  locale?: string;
  toolName?: string;
  toolCallId?: string;
  totalTasks?: number;
  completedTasks?: number;
  elapsed_ms?: number;
  reason?: string;
  errorPreview?: string;
  error?: string;
  agentId?: string;
  agentRole?: string;
  /** For budget_warning: 'soft' | 'hard' | 'rotate' */
  level?: string;
  /** For budget_warning: current usage percentage */
  usagePercent?: number;
  /** Context compression lifecycle stage and measured token capacity. */
  compressionStage?: 'preparing' | 'summarizing' | 'saving' | 'completed' | 'failed';
  sourceTokens?: number;
  summaryTokens?: number;
  contextWindow?: number;
  /** Number of currently executing tasks */
  runningTasks?: number;
  /** Number of tasks waiting to execute */
  pendingTasks?: number;
  /** Summary text (e.g. agent completion summary) */
  summary?: string;
  /** Managed worker job identifier */
  jobId?: string;
  /** Managed worker adapter id */
  adapterId?: string;
  /** Managed worker runtime label shown to users */
  runtimeLabel?: string;
  /** Managed worker lifecycle status */
  workerStatus?: string;
  /** Managed worker execution lane */
  lane?: string;
  /** Managed worker sandbox profile */
  sandboxProfile?: string;
  /** Whether this worker_status event is a periodic heartbeat */
  heartbeat?: boolean;
  /** Chat ID for multi-chat isolation */
  chatId?: string;
  /** Tenant ID for persisted runtime timeline isolation */
  tenantId?: string;
  /** DB session ID for lossless Web UI timeline restore */
  sessionId?: string;
  /** Turn ID for one user request lifecycle */
  turnId?: string;
  /** Short description of tool intent (e.g. file path, command snippet) */
  intent?: string;
  /** Skill that triggered this tool call (if identifiable) */
  skillName?: string;
  /** One-line skill frontmatter description for use_skill activations. */
  skillDescription?: string;
  /** use_skill load outcome for UI rendering. */
  skillLoadOutcome?: 'success' | 'not_found' | 'ineligible';
  /** Missing binary requirements for ineligible skill loads. */
  skillMissingBins?: string[];
  /** Missing environment requirements for ineligible skill loads. */
  skillMissingEnv?: string[];
  /** Short structured use_skill failure reason. */
  skillLoadError?: string;
  /** Approval request identifier for approval_request events */
  approvalRequestId?: string;
  /** Approval action, e.g. permission_elevation */
  approvalAction?: string;
  /** Terminal status for approval_resolved events */
  approvalStatus?: 'approved' | 'rejected';
  /** Permission elevation fields for approval_request events */
  currentLevel?: string;
  requiredLevel?: string;
  deniedAction?: string;
  permissionLevel?: string;
  /** User-selected approval scope for a resolved request. */
  grantScope?: 'once' | 'session';
  approvalTool?: string;
  toolIntent?: string;
  originatingPrompt?: string;
  /** For path_scope_grant approval_request events: the out-of-scope target path. */
  targetPath?: string;
  /** Truncated tool output (first 200 chars, tool_result only) */
  result?: string;
  /** Web sources the tool consulted (tool_result only, search/fetch tools). */
  sources?: ToolSourceRef[];
  /** For turn_state: internal control-plane state */
  turnState?: string;
  /** For turn_state: optional transition detail. For task_completed: the
   *  step's result excerpt, disclosed behind its plan-card row. */
  detail?: string;
  /** Human-readable description for approval and runtime events. */
  description?: string;
  /** For background_agent_complete: path to persisted result file */
  resultPath?: string;
  /** For background_agent_complete: compact result reference marker */
  resultRef?: string;
  timestamp: number;
}

/** Event without timestamp (auto-added by emit) */
export type ProgressEventInput = Omit<ProgressEvent, 'timestamp'>;

/** Handler function for progress events */
export type ProgressHandler = (event: ProgressEvent) => void;

// ---------------------------------------------------------------------------
// Bus singleton
// ---------------------------------------------------------------------------

const CHANNEL = 'progress';

const bus = new EventEmitter();
// Prevent warning for many listeners (channels + websocket + gateway)
bus.setMaxListeners(50);

/**
 * Emit a progress event. Timestamp is added automatically.
 */
export function emit(event: ProgressEventInput): void {
  const full: ProgressEvent = { ...event, timestamp: Date.now() };
  bus.emit(CHANNEL, full);
}

/**
 * Subscribe to progress events.
 * @returns Unsubscribe function.
 */
export function on(handler: ProgressHandler): () => void {
  bus.on(CHANNEL, handler);
  return () => {
    bus.off(CHANNEL, handler);
  };
}

/**
 * Remove all progress event listeners. Useful for tests.
 */
export function removeAllListeners(): void {
  bus.removeAllListeners(CHANNEL);
}
