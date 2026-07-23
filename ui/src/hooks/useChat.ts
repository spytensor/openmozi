import { useState, useCallback, useRef } from "react";
import type { ChatMessage, ToolEvent, TaskUpdate, PlanStartedUpdate, ApprovalRequest, Artifact, MemoryUpdate, TimelineItem, SessionState, ContextCompressionState, TurnEnvelope } from "@/types";
import { genId } from "@/lib/utils";

interface InboundMsg {
  type: string;
  [key: string]: any;
}

/**
 * Turn-lifecycle markers are keyed `${turnId}:${stage}`. They exist only to drive
 * session state (input lock / thinking indicator) and must never render as work
 * steps — the timeline shows real tool events and the answer, not an invented
 * "received → planning → working → responding" narrative. Real background jobs are
 * keyed by jobId and never match this pattern, so they still render normally.
 */
const TURN_LIFECYCLE_TASK_ID = /:(received|planning|working|responding|failed)$/;
const SESSION_SCOPED_WS_TYPES = new Set([
  "message",
  "stream_start",
  "stream_chunk",
  "stream_end",
  "tool_event",
  "tool_composing",
  "task_progress",
  "plan_started",
  "approval_request",
  "approval_resolved",
  "artifact_open",
  "artifact_patch",
  "artifact_close",
  "active_turn",
  "turn_envelope",
  "context_compression",
  "memory_update",
  "error",
]);

function shouldIgnoreSessionScopedMessage(msg: InboundMsg, activeSessionId: string | null): boolean {
  if (!SESSION_SCOPED_WS_TYPES.has(msg.type)) return false;
  const nestedSessionId = msg.type === "turn_envelope" && typeof msg.turn?.sessionId === "string"
    ? msg.turn.sessionId
    : "";
  const sessionId = typeof msg.sessionId === "string" ? msg.sessionId.trim() : nestedSessionId.trim();
  if (sessionId) return sessionId !== activeSessionId;

  // Runtime command responses are transport-level diagnostics, not chat turns.
  // Older command responses are unscoped, so keep the filter deliberately narrow.
  if (msg.type === "message" && msg.role === "assistant" && typeof msg.content === "string") {
    return /^(Runtime Status|Agent Runtime — Commands)(?:\n|$)/.test(msg.content.trim());
  }

  return false;
}

function normalizeTaskStatus(status: unknown): TaskUpdate["status"] {
  return status === "pending" || status === "running" || status === "completed" || status === "failed"
    ? status
    : "running";
}

function normalizeUserStatus(status: unknown): TaskUpdate["userStatus"] | undefined {
  return status === "received" ||
    status === "planning" ||
    status === "responding" ||
    status === "checking" ||
    status === "starting" ||
    status === "working" ||
    status === "verifying" ||
    status === "done" ||
    status === "blocked"
    ? status
    : undefined;
}

function cleanTurnId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Server-assigned per-turn sequence (Issue #627); ignore anything non-numeric. */
function cleanSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Backfill a turn id onto the most recent user message that lacks one (Issue
 * #625). The optimistic user row is added before the server assigns turn
 * identity; the first identity-bearing frame of the turn (`active_turn`,
 * `stream_start`, `tool_event`, running `task_progress`) stamps it so the
 * deterministic projection groups the prompt with its turn. Idempotent: a user
 * message that already carries a turn id is left untouched.
 */
function backfillLatestUserTurnId(prev: TimelineItem[], turnId: string): TimelineItem[] {
  for (let i = prev.length - 1; i >= 0; i--) {
    const item = prev[i];
    if (item.type !== "message") continue;
    const message = item.data as ChatMessage;
    if (message.role !== "user") continue;
    if (message.turnId) return prev;
    const updated = [...prev];
    updated[i] = { ...item, data: { ...message, turnId } };
    return updated;
  }
  return prev;
}

function isFailureMessage(item: TimelineItem): boolean {
  if (item.type !== "message") return true;
  const message = item.data as ChatMessage;
  if (message.role === "user") return false;
  return /^(request failed|error:)|invalid api key|authentication_error|rate_limit_error|token plan|用量上限/i
    .test(message.content.trim());
}

/** Collapse retry rows written by older builds: one prompt, latest result. */
export function compactLegacyRetryTimeline(items: TimelineItem[]): TimelineItem[] {
  const result: TimelineItem[] = [];
  const lastUserByContent = new Map<string, number>();
  for (const item of items) {
    if (item.type === "message" && (item.data as ChatMessage).role === "user") {
      const message = item.data as ChatMessage;
      const key = message.content.trim();
      const previousIndex = key ? lastUserByContent.get(key) : undefined;
      const previous = previousIndex !== undefined ? result[previousIndex]?.data as ChatMessage | undefined : undefined;
      const isLegacyDuplicate = !message.turnId && !previous?.turnId;
      if (isLegacyDuplicate && previousIndex !== undefined && result.slice(previousIndex + 1).every(isFailureMessage)) {
        result.splice(previousIndex + 1);
        continue;
      }
      if (key) lastUserByContent.set(key, result.length);
    }
    result.push(item);
  }
  return result;
}

function upsertTaskUpdate(prev: TimelineItem[], task: TaskUpdate): TimelineItem[] {
  const existing = prev.findIndex(
    (item) => item.type === "task_update" && (item.data as TaskUpdate).task_id === task.task_id,
  );
  if (existing >= 0) {
    const prior = prev[existing].data as TaskUpdate;
    // Preserve the first-seen turn identity + sequence: a later progress frame
    // may omit them, but the row keeps the turn it was assigned to (Issue #625).
    const merged: TaskUpdate = {
      ...task,
      // Sibling order is based on when the task first appeared, not when its
      // latest heartbeat/terminal update arrived.
      timestamp: prior.timestamp,
      turnId: task.turnId ?? prior.turnId,
      seq: task.seq ?? prior.seq,
      // Preserve the first-seen parent linkage (Issue #624): a later progress
      // frame (e.g. a worker heartbeat) may omit it, but the task keeps the group
      // it was assigned to so concurrent children never re-parent or merge.
      parentTaskId: task.parentTaskId ?? prior.parentTaskId,
      // A completion frame carries the step's result excerpt; any later frame
      // without one must not wipe it (the plan card discloses it per row).
      detail: task.detail ?? prior.detail,
    };
    const updated = [...prev];
    updated[existing] = { type: "task_update", timestamp: prior.timestamp, data: merged };
    return updated;
  }
  return [...prev, { type: "task_update", timestamp: task.timestamp, data: task }];
}

function applyArtifactPatch(existing: Artifact, patch: Record<string, unknown>): Artifact {
  const knownKeys = new Set(["plugin_id", "title", "status", "fallback_text", "data", "updated_at"]);
  const dataPatch = {
    ...(
      patch.data && typeof patch.data === "object" && !Array.isArray(patch.data)
        ? patch.data as Record<string, unknown>
        : {}
    ),
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => !knownKeys.has(key))),
  };
  const topLevelPatch = Object.fromEntries(
    Object.entries(patch).filter(
      ([key]) => key === "plugin_id" || key === "title" || key === "status" || key === "fallback_text",
    ),
  ) as Partial<Artifact>;
  // Prefer the runtime's clock when it sends one, so restored timelines sort by
  // when the work happened rather than when this client received the event.
  const patchedAt = typeof patch.updated_at === "string" ? Date.parse(patch.updated_at) : NaN;
  return {
    ...existing,
    ...topLevelPatch,
    ...(Number.isFinite(patchedAt) ? { timestamp: patchedAt } : {}),
    data: {
      ...existing.data,
      ...dataPatch,
    },
  };
}

export function useChat(activeSessionId?: string | null) {
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [sessionState, setSessionState] = useState<SessionState>("IDLE");
  const [currentModel, setCurrentModel] = useState("");
  const [queue, setQueue] = useState<string[]>([]);
  /** Name of the currently executing tool (null when idle or streaming) */
  const [activeTool, setActiveTool] = useState<string | null>(null);
  const [activeToolSkillName, setActiveToolSkillName] = useState<string | null>(null);
  /**
   * The turn currently doing work, tracked from real runtime signals (tool
   * events, running task progress). Replaces the old approach of inferring
   * activity from lifecycle rows in the timeline.
   */
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [contextCompression, setContextCompression] = useState<ContextCompressionState | null>(null);
  /**
   * Timeline capabilities the server advertised in `welcome` (Issue #625). Gates
   * the deterministic turn projection; empty until the runtime declares it.
   */
  const [timelineCapabilities, setTimelineCapabilities] = useState<string[]>([]);
  /** Server-authoritative turn envelopes for the active session, from restore. */
  const [turns, setTurns] = useState<TurnEnvelope[]>([]);
  const activeSessionIdRef = useRef<string | null>(activeSessionId ?? null);
  const streamingRef = useRef<Map<string, string>>(new Map());
  const streamTurnIdsRef = useRef<Map<string, string>>(new Map());
  const streamSeqRef = useRef<Map<string, number>>(new Map());

  activeSessionIdRef.current = activeSessionId ?? null;

  const addMessage = useCallback((role: ChatMessage["role"], content: string, id?: string, turnId?: string, attachments?: ChatMessage["attachments"], seq?: number) => {
    const msg: ChatMessage = {
      id: id || genId(),
      role,
      content,
      timestamp: Date.now(),
      ...(turnId ? { turnId } : {}),
      ...(seq != null ? { seq } : {}),
      ...(attachments?.length ? { attachments } : {}),
    };
    setTimeline((prev) => [...prev, { type: "message", timestamp: msg.timestamp, data: msg }]);
    return msg.id;
  }, []);

  const handleWSMessage = useCallback((msg: InboundMsg): boolean => {
    if (shouldIgnoreSessionScopedMessage(msg, activeSessionIdRef.current)) return false;
    const now = Date.now();

    switch (msg.type) {
      case "context_compression": {
        setContextCompression({
          sessionId: msg.sessionId,
          stage: msg.stage,
          sourceTokens: Number(msg.sourceTokens) || 0,
          summaryTokens: typeof msg.summaryTokens === "number" ? msg.summaryTokens : undefined,
          contextWindow: Number(msg.contextWindow) || 0,
          timestamp: typeof msg.timestamp === "number" ? msg.timestamp : now,
        });
        break;
      }
      case "welcome": {
        if (msg.model) setCurrentModel(msg.model);
        if (Array.isArray(msg.capabilities)) {
          setTimelineCapabilities(msg.capabilities.filter((c: unknown): c is string => typeof c === "string"));
        }
        break;
      }

      // The runtime queued this message because a turn is already running for
      // the session (or a concurrency limit was hit). Surface it instead of
      // silently dropping the notice.
      case "turn_queue": {
        addMessage("system", "The agent is busy with another turn — your message is queued and will run next.");
        break;
      }

      // Authoritative runtime answer to "is anything running for this chat" —
      // sent on (re)connect. A live turn re-arms the working state (and with it
      // the stop button); null means nothing is running, so any in-flight steps
      // in the restored timeline are orphans and must not spin.
      case "active_turn": {
        if (typeof msg.turnId === "string" && msg.turnId) {
          const turnId = msg.turnId;
          if (msg.sessionId) {
            setTurns((prev) => {
              const index = prev.findIndex((turn) => turn.turnId === turnId);
              const next: TurnEnvelope = {
                ...(index >= 0 ? prev[index] : {
                  turnId,
                  sessionId: msg.sessionId!,
                  chatId: "",
                  origin: "user" as const,
                  status: "active" as const,
                  seqHighWater: 0,
                  startedAt: msg.startedAt ?? now,
                }),
                ...(typeof msg.locale === "string" ? { locale: msg.locale } : {}),
              };
              if (index < 0) return [...prev, next];
              const copy = [...prev];
              copy[index] = next;
              return copy;
            });
          }
          setActiveTurnId(turnId);
          setSessionState("WORKING");
          setTimeline((prev) => backfillLatestUserTurnId(prev, turnId));
        } else {
          // Authoritative "nothing is running": unstick a WORKING state left over
          // from before a disconnect/restart so the input is never locked forever.
          setActiveTurnId(null);
          setSessionState("IDLE");
          setActiveTool(null);
          setActiveToolSkillName(null);
        }
        break;
      }

      case "turn_envelope": {
        const incoming = msg.turn;
        if (!incoming?.turnId || !incoming.sessionId) break;
        setTurns((prev) => {
          const index = prev.findIndex((turn) => turn.turnId === incoming.turnId);
          if (index < 0) return [...prev, incoming];
          const copy = [...prev];
          copy[index] = incoming;
          return copy;
        });
        break;
      }

      case "message": {
        // Filter out noise: pong, connection confirmations
        const text = msg.content ?? "";
        if (msg.role === "system" && (
          text === "pong" ||
          text.startsWith("Connected as ") ||
          text.startsWith("Authenticated as ")
        )) break;
        if (msg.role === "assistant" && msg.regenerate === true) {
          const turnId = cleanTurnId(msg.turnId);
          const seq = cleanSeq(msg.seq);
          setTimeline((prev) => {
            let latestUser = -1;
            for (let index = prev.length - 1; index >= 0; index--) {
              const item = prev[index];
              if (item.type === "message" && (item.data as ChatMessage).role === "user") {
                latestUser = index;
                break;
              }
            }
            const stable = latestUser >= 0 ? prev.slice(0, latestUser + 1) : prev;
            const withTurn = turnId ? backfillLatestUserTurnId(stable, turnId) : stable;
            const message: ChatMessage = {
              id: msg.id || genId(),
              role: "assistant",
              content: msg.content,
              timestamp: now,
              ...(turnId ? { turnId } : {}),
              ...(seq != null ? { seq } : {}),
            };
            return [...withTurn, { type: "message", timestamp: now, data: message }];
          });
        } else {
          const turnId = cleanTurnId(msg.turnId);
          if (turnId) setTimeline((prev) => backfillLatestUserTurnId(prev, turnId));
          addMessage(msg.role, msg.content, msg.id, turnId, undefined, cleanSeq(msg.seq));
        }
        if (msg.role === "assistant") {
          setSessionState("IDLE");
          setActiveTool(null);
          setActiveToolSkillName(null);
          setActiveTurnId(null);
        }
        break;
      }

      case "stream_start": {
        const turnId = cleanTurnId(msg.turnId);
        const seq = cleanSeq(msg.seq);
        setSessionState("WORKING");
        setActiveTool(null);
        setActiveToolSkillName(null);
        streamingRef.current.set(msg.requestId, "");
        if (seq != null) streamSeqRef.current.set(msg.requestId, seq);
        if (turnId) {
          streamTurnIdsRef.current.set(msg.requestId, turnId);
          setActiveTurnId(turnId);
          setTimeline((prev) => backfillLatestUserTurnId(prev, turnId));
        }
        break;
      }

      case "stream_chunk": {
        const turnId = cleanTurnId(msg.turnId) ?? streamTurnIdsRef.current.get(msg.requestId);
        if (turnId) streamTurnIdsRef.current.set(msg.requestId, turnId);
        const frameSeq = cleanSeq(msg.seq);
        if (frameSeq != null) streamSeqRef.current.set(msg.requestId, frameSeq);
        const seq = streamSeqRef.current.get(msg.requestId);
        // Backend sends fully accumulated text (not deltas), so replace directly
        streamingRef.current.set(msg.requestId, msg.content);
        if ((msg.content ?? "").trim().length > 0) {
          setSessionState("RESPONDING");
        }
        setTimeline((prev) => {
          let found = false;
          const updated = prev.map((item) => {
            if (item.type === "message" && (item.data as ChatMessage).requestId === msg.requestId) {
              found = true;
              return { ...item, data: { ...(item.data as ChatMessage), content: msg.content, ...(turnId ? { turnId } : {}), ...(seq != null ? { seq } : {}) } };
            }
            return item;
          });
          if (found) return updated;
          const streamMsg: ChatMessage = {
            id: msg.requestId,
            role: "assistant",
            content: msg.content,
            timestamp: now,
            streaming: true,
            requestId: msg.requestId,
            ...(turnId ? { turnId } : {}),
            ...(seq != null ? { seq } : {}),
          };
          return [...updated, { type: "message", timestamp: now, data: streamMsg }];
        });
        break;
      }

      case "stream_end": {
        const turnId = cleanTurnId(msg.turnId) ?? streamTurnIdsRef.current.get(msg.requestId);
        const frameSeq = cleanSeq(msg.seq);
        if (frameSeq != null) streamSeqRef.current.set(msg.requestId, frameSeq);
        const seq = streamSeqRef.current.get(msg.requestId);
        streamingRef.current.delete(msg.requestId);
        streamTurnIdsRef.current.delete(msg.requestId);
        streamSeqRef.current.delete(msg.requestId);
        setTimeline((prev) => {
          let found = false;
          const updated = prev.flatMap((item) => {
            if (item.type !== "message" || (item.data as ChatMessage).requestId !== msg.requestId) {
              return [item];
            }
            found = true;
            const existing = item.data as ChatMessage;
            const finalContent = (msg.content ?? "").trim().length > 0 ? msg.content : existing.content;
            if ((finalContent ?? "").trim().length === 0) {
              return [];
            }
            return [{ ...item, data: { ...existing, content: finalContent, streaming: false, ...(turnId ? { turnId } : {}), ...(seq != null ? { seq } : {}) } }];
          });
          if (found || (msg.content ?? "").trim().length === 0) return updated;
          const finalMsg: ChatMessage = {
            id: msg.requestId,
            role: "assistant",
            content: msg.content,
            timestamp: now,
            streaming: false,
            requestId: msg.requestId,
            ...(turnId ? { turnId } : {}),
            ...(seq != null ? { seq } : {}),
          };
          return [...updated, { type: "message", timestamp: now, data: finalMsg }];
        });
        setSessionState("IDLE");
        break;
      }

      case "tool_composing": {
        // Ephemeral presence while the model streams a tool call's arguments
        // (e.g. composing a document into file_write). Drives ONLY the live
        // activity label; nothing enters the timeline. The real tool_event
        // start that follows re-asserts the same tool.
        if (msg.phase === "start" && typeof msg.tool === "string" && msg.tool) {
          setSessionState("WORKING");
          setActiveTool(msg.tool);
          setActiveToolSkillName(null);
        } else if (msg.phase === "end") {
          setActiveTool(null);
          setActiveToolSkillName(null);
        }
        if (typeof msg.turnId === "string" && msg.turnId) setActiveTurnId(msg.turnId);
        break;
      }
      case "tool_event": {
        const eventTs = typeof msg.timestamp === "number" ? msg.timestamp : now;
        const te: ToolEvent = {
          id: genId(),
          callId: msg.callId,
          taskId: msg.taskId,
          turnId: msg.turnId,
          seq: cleanSeq(msg.seq),
          agentId: msg.agentId,
          tool: msg.tool,
          phase: msg.phase,
          status: msg.status,
          intent: msg.intent,
          result: msg.result,
          sources: msg.sources,
          error: msg.error,
          elapsed_ms: msg.elapsed_ms,
          skillName: msg.skillName,
          skillDescription: msg.skillDescription,
          skillLoadOutcome: msg.skillLoadOutcome,
          skillMissingBins: msg.skillMissingBins,
          skillMissingEnv: msg.skillMissingEnv,
          skillLoadError: msg.skillLoadError,
          timestamp: eventTs,
        };
        if (msg.turnId) {
          const turnId = msg.turnId;
          setActiveTurnId(turnId);
          if (msg.phase === "start") setTimeline((prev) => backfillLatestUserTurnId(prev, turnId));
        }
        if (msg.phase === "start") {
          setSessionState("WORKING");
          setActiveTool(msg.tool);
          setActiveToolSkillName(msg.skillName ?? null);
          setTimeline((prev) => [...prev, { type: "tool_event", timestamp: eventTs, data: te }]);
        } else {
          setActiveTool(null);
          setActiveToolSkillName(null);
          setTimeline((prev) =>
            prev.map((item) => {
              if (item.type === "tool_event" && (item.data as ToolEvent).callId === msg.callId) {
                const existing = item.data as ToolEvent;
                return {
                  ...item,
                  // Terminal frames update outcome, not first-seen chronology.
                  timestamp: item.timestamp,
                  data: {
                    ...existing,
                    ...te,
                    timestamp: existing.timestamp,
                    intent: te.intent ?? existing.intent,
                    sources: te.sources ?? existing.sources,
                    taskId: te.taskId ?? existing.taskId,
                    turnId: te.turnId ?? existing.turnId,
                    seq: te.seq ?? existing.seq,
                    agentId: te.agentId ?? existing.agentId,
                    skillName: te.skillName ?? existing.skillName,
                    skillDescription: te.skillDescription ?? existing.skillDescription,
                    skillLoadOutcome: te.skillLoadOutcome ?? existing.skillLoadOutcome,
                    skillMissingBins: te.skillMissingBins ?? existing.skillMissingBins,
                    skillMissingEnv: te.skillMissingEnv ?? existing.skillMissingEnv,
                    skillLoadError: te.skillLoadError ?? existing.skillLoadError,
                  },
                };
              }
              return item;
            })
          );
        }
        break;
      }

      case "memory_update": {
        const turnId = cleanTurnId(msg.turnId);
        const seq = cleanSeq(msg.seq);
        const timestamp = typeof msg.timestamp === "number" ? msg.timestamp : now;
        const update: MemoryUpdate = {
          count: Number(msg.count) || 0,
          added: Number(msg.added) || 0,
          reinforced: Number(msg.reinforced) || 0,
          updated: Number(msg.updated) || 0,
          factIds: Array.isArray(msg.factIds)
            ? msg.factIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0)
            : [],
          timestamp,
          ...(turnId ? { turnId } : {}),
          ...(seq != null ? { seq } : {}),
        };
        setTimeline((prev) => {
          const existing = turnId
            ? prev.findIndex(item => item.type === "memory_update" && item.turnId === turnId)
            : -1;
          const item: TimelineItem = {
            type: "memory_update",
            timestamp,
            data: update,
            ...(turnId ? { turnId } : {}),
            ...(seq != null ? { seq } : {}),
          };
          if (existing < 0) return [...prev, item];
          const copy = [...prev];
          copy[existing] = item;
          return copy;
        });
        break;
      }

      case "task_update": {
        const eventTs = typeof msg.timestamp === "number" ? msg.timestamp : now;
        const tu: TaskUpdate = {
          id: genId(),
          task_id: msg.task_id,
          parentTaskId: cleanTurnId(msg.parentTaskId),
          turnId: msg.turnId,
          seq: cleanSeq(msg.seq),
          title: msg.title,
          status: normalizeTaskStatus(msg.status),
          rawStatus: typeof msg.rawStatus === "string" ? msg.rawStatus : undefined,
          progress: msg.progress,
          detail: typeof msg.detail === "string" ? msg.detail : undefined,
          timestamp: eventTs,
        };
        setTimeline((prev) => upsertTaskUpdate(prev, tu));
        break;
      }

      case "task_progress": {
        const eventTs = typeof msg.timestamp === "number" ? msg.timestamp : now;
        const taskId = msg.task_id || msg.jobId;
        if (!taskId) break;
        const status = normalizeTaskStatus(msg.status);
        const userStatus = normalizeUserStatus(msg.userStatus);

        // Every marker drives session state (input lock / thinking indicator).
        if (status === "running" || status === "pending") {
          setSessionState("WORKING");
          if (msg.turnId) {
            const turnId = msg.turnId;
            setActiveTurnId(turnId);
            setTimeline((prev) => backfillLatestUserTurnId(prev, turnId));
          }
        } else if (status === "failed") {
          setSessionState("IDLE");
          setActiveTool(null);
          setActiveToolSkillName(null);
          setActiveTurnId(null);
        } else if (status === "completed" && userStatus === "responding") {
          setSessionState("IDLE");
          setActiveTool(null);
          setActiveToolSkillName(null);
          setActiveTurnId(null);
        }

        // Turn-lifecycle markers are session-state only — never rendered as steps.
        if (TURN_LIFECYCLE_TASK_ID.test(taskId)) break;

        const tu: TaskUpdate = {
          id: genId(),
          task_id: taskId,
          parentTaskId: cleanTurnId(msg.parentTaskId),
          jobId: msg.jobId,
          turnId: msg.turnId,
          seq: cleanSeq(msg.seq),
          title: msg.title || "Working on task",
          status,
          progress: msg.progress,
          userStatus,
          detail: msg.detail,
          rawStatus: msg.rawStatus,
          runtimeLabel: msg.runtimeLabel,
          adapterId: msg.adapterId,
          lane: msg.lane,
          sandboxProfile: msg.sandboxProfile,
          heartbeat: msg.heartbeat,
          elapsed_ms: msg.elapsed_ms,
          timestamp: eventTs,
        };
        setTimeline((prev) => upsertTaskUpdate(prev, tu));
        break;
      }

      case "plan_started": {
        if (typeof msg.plan_id !== "string" || !msg.plan_id || typeof msg.goal !== "string" || !Array.isArray(msg.phases)) break;
        const eventTs = typeof msg.timestamp === "number" ? msg.timestamp : now;
        const plan: PlanStartedUpdate = {
          plan_id: msg.plan_id,
          goal: msg.goal,
          phases: msg.phases,
          locale: typeof msg.locale === "string" ? msg.locale : undefined,
          turnId: cleanTurnId(msg.turnId),
          seq: cleanSeq(msg.seq),
          timestamp: eventTs,
        };
        setTimeline((prev) => {
          const withTurn = plan.turnId ? backfillLatestUserTurnId(prev, plan.turnId) : prev;
          const existing = withTurn.findIndex(
            (entry) => entry.type === "plan_started" && (entry.data as PlanStartedUpdate).plan_id === plan.plan_id,
          );
          if (existing < 0) {
            return [...withTurn, {
              type: "plan_started",
              timestamp: eventTs,
              data: plan,
              ...(plan.turnId ? { turnId: plan.turnId } : {}),
              ...(plan.seq != null ? { seq: plan.seq } : {}),
            }];
          }
          // Same first-seen semantics as upsertTaskUpdate (Issue #625): a
          // replayed frame refreshes content but never moves the row — the
          // first-assigned timestamp/turn/sequence hold its position steady.
          const prior = withTurn[existing];
          const priorData = prior.data as PlanStartedUpdate;
          const merged: PlanStartedUpdate = {
            ...plan,
            timestamp: priorData.timestamp,
            turnId: plan.turnId ?? priorData.turnId,
            seq: plan.seq ?? priorData.seq,
          };
          const copy = [...withTurn];
          copy[existing] = {
            type: "plan_started",
            timestamp: prior.timestamp,
            data: merged,
            ...(merged.turnId ? { turnId: merged.turnId } : {}),
            ...(merged.seq != null ? { seq: merged.seq } : {}),
          };
          return copy;
        });
        break;
      }

      case "approval_request": {
        const ar: ApprovalRequest = {
          id: msg.id,
          description: msg.description,
          action: typeof msg.action === "string" ? msg.action : undefined,
          status: "pending",
          timestamp: now,
          turnId: cleanTurnId(msg.turnId),
          seq: cleanSeq(msg.seq),
          required_level: typeof msg.required_level === "string" ? msg.required_level : undefined,
          current_level: typeof msg.current_level === "string" ? msg.current_level : undefined,
          denied_action: typeof msg.denied_action === "string" ? msg.denied_action : undefined,
          tool: typeof msg.tool === "string" ? msg.tool : undefined,
          tool_intent: typeof msg.tool_intent === "string" ? msg.tool_intent : undefined,
          originating_prompt: typeof msg.originating_prompt === "string" ? msg.originating_prompt : undefined,
        };
        setTimeline((prev) => {
          const withTurn = ar.turnId ? backfillLatestUserTurnId(prev, ar.turnId) : prev;
          return [...withTurn, { type: "approval_request", timestamp: now, data: ar }];
        });
        if (ar.turnId && typeof msg.sessionId === "string") {
          setTurns((prev) => prev.map((turn) => turn.turnId === ar.turnId
            ? { ...turn, status: "awaiting_approval" }
            : turn));
        }
        break;
      }

      case "approval_resolved": {
        const status = msg.status === "approved" ? "approved" : msg.status === "rejected" ? "rejected" : null;
        if (!status) break;
        setTimeline((prev) =>
          prev.map((item) => {
            if (item.type !== "approval_request" || (item.data as ApprovalRequest).id !== msg.id) return item;
            const existing = item.data as ApprovalRequest;
            return {
              ...item,
              data: {
                ...existing,
                status,
                action: typeof msg.action === "string" ? msg.action : existing.action,
                description: typeof msg.description === "string" ? msg.description : existing.description,
                required_level: typeof msg.required_level === "string" ? msg.required_level : existing.required_level,
                current_level: typeof msg.current_level === "string" ? msg.current_level : existing.current_level,
                denied_action: typeof msg.denied_action === "string" ? msg.denied_action : existing.denied_action,
                tool: typeof msg.tool === "string" ? msg.tool : existing.tool,
                tool_intent: typeof msg.tool_intent === "string" ? msg.tool_intent : existing.tool_intent,
                originating_prompt: typeof msg.originating_prompt === "string" ? msg.originating_prompt : existing.originating_prompt,
              },
            };
          })
        );
        if (typeof msg.turnId === "string" && msg.turnId) {
          setTurns((prev) => prev.map((turn) => turn.turnId === msg.turnId
            ? { ...turn, status: "active" }
            : turn));
        }
        break;
      }

      case "artifact_open": {
        const a = msg.artifact;
        const artifactTurnId = cleanTurnId(msg.turnId);
        const art: Artifact = {
          id: a.id,
          plugin_id: a.plugin_id,
          title: a.title,
          status: a.status,
          fallback_text: a.fallback_text,
          data: a.data,
          timestamp: now,
          ...(artifactTurnId ? { turnId: artifactTurnId } : {}),
          ...(cleanSeq(msg.seq) != null ? { seq: cleanSeq(msg.seq) } : {}),
        };
        setTimeline((prev) => {
          const withTurn = artifactTurnId ? backfillLatestUserTurnId(prev, artifactTurnId) : prev;
          const preIdx = withTurn.findIndex(
            (item) => item.type === "artifact" && (item.data as Artifact).id === a.id,
          );
          if (preIdx >= 0) {
            const prior = withTurn[preIdx].data as Artifact;
            const updated = [...withTurn];
            // Preserve first-assigned identity if the reopen frame omits it.
            updated[preIdx] = {
              type: "artifact",
              timestamp: now,
              data: { ...art, turnId: art.turnId ?? prior.turnId, seq: art.seq ?? prior.seq },
            };
            return updated;
          }
          return [...withTurn, { type: "artifact", timestamp: now, data: art }];
        });
        break;
      }

      case "artifact_patch": {
        // The server moves an artifact to the turn that regenerated it, so a
        // patch can carry a new owner. Adopt it: the timeline groups by turn, and
        // ignoring this left the card rendering under the turn that first
        // produced it until a reload silently moved it — the live view and the
        // restored view disagreeing about where the same card belongs.
        const patchTurnId = cleanTurnId(msg.turnId);
        const patchSeq = cleanSeq(msg.seq);
        const patchedAt = Date.now();
        setTimeline((prev) =>
          prev.map((item) => {
            if (item.type === "artifact" && (item.data as Artifact).id === msg.artifactId) {
              const existing = item.data as Artifact;
              const patched = applyArtifactPatch(existing, msg.patch as Record<string, unknown>);
              // Turn identity lives at the item level for a restored row — the
              // server persists it in the `turn_id` column and never writes it
              // into the artifact payload — and at the data level for one opened
              // live this session. Read both, in the order the projection does,
              // or a reloaded session never moves the card: its `data.turnId` is
              // undefined, so the comparison short-circuits and this branch
              // silently never runs.
              const currentTurnId = item.turnId ?? existing.turnId;
              const movesTurn = Boolean(patchTurnId && currentTurnId && patchTurnId !== currentTurnId);
              if (!movesTurn) return { ...item, data: patched };
              // Moving turns means moving position too, mirroring the server:
              // it now sorts with the turn that produced this content.
              //
              // Both `item.turnId` and `data.turnId` must move. The projection
              // reads `item.turnId ?? data.turnId` (turn-projection.ts,
              // ChatView.renderTurnId), and a restored row carries `item.turnId`
              // from the server — so setting only `data.turnId` would leave the
              // card on its old turn for exactly the sessions that had been
              // reloaded.
              return {
                ...item,
                timestamp: patchedAt,
                turnId: patchTurnId,
                ...(patchSeq != null ? { seq: patchSeq } : {}),
                data: {
                  ...patched,
                  turnId: patchTurnId,
                  ...(patchSeq != null ? { seq: patchSeq } : {}),
                  timestamp: patchedAt,
                },
              };
            }
            return item;
          })
        );
        break;
      }

      // The runtime's authoritative "this artifact is done being shown" — mark it
      // closed in place; the card stays as a historical record, and App closes the
      // workspace panel if this artifact is the one open.
      case "artifact_close": {
        setTimeline((prev) =>
          prev.map((item) => {
            if (item.type === "artifact" && (item.data as Artifact).id === msg.artifactId) {
              const existing = item.data as Artifact;
              if (existing.status === "closed") return item;
              return { ...item, data: { ...existing, status: "closed" } };
            }
            return item;
          })
        );
        break;
      }

      case "error":
        addMessage("system", `Error: ${msg.message}`);
        setSessionState("IDLE");
        setActiveTool(null);
        setActiveToolSkillName(null);
        setActiveTurnId(null);
        break;
    }
    return true;
  }, [addMessage]);

  const resolveApproval = useCallback((id: string, approved: boolean) => {
    setTimeline((prev) =>
      prev.map((item) => {
        if (item.type === "approval_request" && (item.data as ApprovalRequest).id === id) {
          return { ...item, data: { ...(item.data as ApprovalRequest), status: approved ? "approved" : "rejected" } };
        }
        return item;
      })
    );
  }, []);

  const clearTimeline = useCallback(() => {
    setTimeline([]);
    setActiveTurnId(null);
    setTurns([]);
  }, []);

  /** Adopt the server-authoritative turn envelopes returned by timeline restore. */
  const loadTurns = useCallback((restored: TurnEnvelope[]) => {
    setTurns(Array.isArray(restored) ? restored : []);
  }, []);

  /**
   * Adopt a session id the server just bound to this connection (Issue #627),
   * updating the session-scoped filter ref synchronously. The server sends
   * `session_bound` before the turn's first stream frame, but the matching
   * React state (`activeSessionId` prop) only reaches this hook on the next
   * render — too late for a stream_start arriving in the very next WS message.
   * Writing the ref here makes the filter accept those frames immediately; the
   * later re-render sets the same value, so the two never disagree.
   */
  const adoptResolvedSession = useCallback((sessionId: string) => {
    if (sessionId) activeSessionIdRef.current = sessionId;
  }, []);

  const prepareRegenerate = useCallback((content: string) => {
    // Retry is a new turn, not a destructive rewrite of the previous one.
    // Keep the old turn visible and add the new prompt optimistically; the
    // server assigns its fresh turn id on the first identity-bearing frame.
    addMessage("user", content);
    streamingRef.current.clear();
    streamTurnIdsRef.current.clear();
    setActiveTool(null);
    setActiveToolSkillName(null);
    setActiveTurnId(null);
    setSessionState("WORKING");
  }, [addMessage]);

  const loadHistory = useCallback((messages: Array<{ role: string; content: string; timestamp?: number; metadata?: string | null }>) => {
    const items: TimelineItem[] = [];
    for (const m of messages) {
      const ts = m.timestamp || Date.now();
      // Detect persisted artifacts (role='tool', content starts with {"_artifact":true,...)
      if (m.role === "tool" && m.content.startsWith('{"_artifact":true')) {
        try {
          const parsed = JSON.parse(m.content);
          items.push({
            type: "artifact",
            timestamp: ts,
            data: {
              id: parsed.id || genId(),
              plugin_id: parsed.plugin_id,
              title: parsed.title || "Artifact",
              status: parsed.status || "completed",
              fallback_text: typeof parsed.fallback_text === "string" ? parsed.fallback_text : undefined,
              data: parsed.data || {},
              timestamp: ts,
            } as Artifact,
          });
          continue;
        } catch { /* fall through to message */ }
      }
      // Skip tool role messages that aren't artifacts
      if (m.role === "tool") continue;
      // Restore uploaded-file attachments from persisted metadata so the chip
      // re-renders on reload (matches the live-send display).
      let attachments: ChatMessage["attachments"];
      if (m.role === "user" && m.metadata) {
        try {
          const parsed = JSON.parse(m.metadata) as { attachments?: Array<{ filename?: string; path?: string }> };
          const restored = (parsed.attachments ?? [])
            .filter((a) => a && (a.path || a.filename))
            .map((a) => ({ filename: a.filename || (a.path ? a.path.split("/").pop() || "file" : "file"), path: a.path || "" }));
          if (restored.length > 0) attachments = restored;
        } catch { /* ignore malformed metadata */ }
      }
      items.push({
        type: "message",
        timestamp: ts,
        data: {
          id: genId(),
          role: m.role as ChatMessage["role"],
          content: m.content,
          timestamp: ts,
          ...(attachments ? { attachments } : {}),
        } as ChatMessage,
      });
    }
    setTimeline(compactLegacyRetryTimeline(items));
  }, []);

  const loadTimeline = useCallback((items: TimelineItem[]) => {
    // Drop any turn-lifecycle markers persisted by older builds so restored turns
    // never resurrect the fabricated "planning/working" steps.
    const cleaned = items.filter(
      (item) => !(item.type === "task_update" && TURN_LIFECYCLE_TASK_ID.test((item.data as TaskUpdate).task_id)),
    );
    setTimeline(compactLegacyRetryTimeline(cleaned.sort((a, b) => a.timestamp - b.timestamp || (a.eventId ?? 0) - (b.eventId ?? 0))));
  }, []);

  const prependTimeline = useCallback((items: TimelineItem[]) => {
    setTimeline((current) => {
      const byEventId = new Set(current.flatMap((item) => item.eventId === undefined ? [] : [item.eventId]));
      const older = items.filter((item) => item.eventId === undefined || !byEventId.has(item.eventId));
      return [...older, ...current].sort((a, b) => a.timestamp - b.timestamp || (a.eventId ?? 0) - (b.eventId ?? 0));
    });
  }, []);

  return {
    timeline,
    sessionState,
    activeTool,
    activeToolSkillName,
    activeTurnId,
    contextCompression,
    currentModel,
    timelineCapabilities,
    turns,
    loadTurns,
    queue,
    setQueue,
    setSessionState,
    setContextCompression,
    setCurrentModel,
    handleWSMessage,
    addMessage,
    resolveApproval,
    clearTimeline,
    adoptResolvedSession,
    prepareRegenerate,
    loadHistory,
    loadTimeline,
    prependTimeline,
  };
}
