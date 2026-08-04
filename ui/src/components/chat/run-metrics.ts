import type { Artifact, ChatMessage, ChatReasoning, PlanStartedUpdate, TaskUpdate, TimelineItem, ToolEvent } from "@/types";

export type RunReasoningPass = ChatReasoning;

export interface RunPresentationModel {
  items: TimelineItem[];
  plan: PlanStartedUpdate | null;
  tasks: TaskUpdate[];
  taskById: Map<string, TaskUpdate>;
  progress: { completed: number; total: number };
  reasoning: RunReasoningPass[];
  artifacts: Artifact[];
  metrics: { reasoningPasses: number; toolCalls: number; outputs: number };
}

export function timelineItemTurnId(item: TimelineItem): string | undefined {
  return item.turnId ?? (item.data as { turnId?: string }).turnId;
}

function timelineItemSeq(item: TimelineItem): number | undefined {
  return item.seq ?? (item.data as { seq?: number }).seq;
}

function itemVersion(item: TimelineItem): [number, number] {
  return [timelineItemSeq(item) ?? -1, (item.data as { timestamp?: number }).timestamp ?? item.timestamp];
}

function terminalRank(item: TimelineItem): number {
  if (item.type === "task_update") {
    const status = (item.data as TaskUpdate).status;
    return status === "completed" || status === "failed" ? 1 : 0;
  }
  if (item.type === "message") return (item.data as ChatMessage).streaming ? 0 : 1;
  if (item.type === "approval_request") return (item.data as { status: string }).status === "pending" ? 0 : 1;
  if (item.type === "artifact") {
    const status = String((item.data as Artifact).status).toLowerCase();
    return status === "pending" || status === "running" || status === "generating" || status === "streaming" ? 0 : 1;
  }
  return 0;
}

function preferTimelineItem(current: TimelineItem, candidate: TimelineItem): TimelineItem {
  const currentTerminal = terminalRank(current);
  const candidateTerminal = terminalRank(candidate);
  // A completed/failed snapshot must never regress to an older live running
  // copy. Conversely, a later terminal live frame must replace a stale REST
  // running snapshot. This is the shared monotonic boundary for every reader.
  if (currentTerminal !== candidateTerminal) return candidateTerminal > currentTerminal ? candidate : current;
  const [currentSeq, currentTimestamp] = itemVersion(current);
  const [candidateSeq, candidateTimestamp] = itemVersion(candidate);
  if (candidateSeq !== currentSeq) return candidateSeq > currentSeq ? candidate : current;
  if (candidateTimestamp !== currentTimestamp) return candidateTimestamp > currentTimestamp ? candidate : current;
  if (current.type === "message" && candidate.type === "message") {
    const currentContent = (current.data as ChatMessage).content.length;
    const candidateContent = (candidate.data as ChatMessage).content.length;
    if (candidateContent !== currentContent) return candidateContent > currentContent ? candidate : current;
  }
  return candidate;
}

/** Stable identity shared by the REST snapshot and its WebSocket overlay. */
export function timelineIdentityKey(item: TimelineItem, index = 0): string {
  const turnId = timelineItemTurnId(item);
  const seq = timelineItemSeq(item);
  const data = item.data as {
    id?: string;
    requestId?: string;
    callId?: string;
    phase?: string;
    task_id?: string;
    plan_id?: string;
  };
  const owner = turnId ?? "legacy";
  if (item.type === "message" && (data.requestId || data.id)) return `message:${owner}:${data.requestId ?? data.id}`;
  if (item.type === "tool_event" && (data.callId || data.id)) return `tool:${owner}:${data.callId ?? data.id}:${data.phase ?? "event"}`;
  if (item.type === "task_update" && (data.task_id || data.id)) return `task:${owner}:${data.task_id ?? data.id}`;
  if (item.type === "plan_started" && data.plan_id) return `plan:${owner}:${data.plan_id}`;
  if (item.type === "artifact" && data.id) return `artifact:${owner}:${data.id}`;
  if (item.type === "approval_request" && data.id) return `approval:${owner}:${data.id}`;
  if (turnId && seq != null) return `turn:${turnId}:${seq}:${item.type}`;
  return `row:${item.type}:${data.id ?? item.timestamp}:${index}`;
}

export function mergeRunTimeline(
  snapshot: TimelineItem[],
  live: TimelineItem[],
  turnIds: ReadonlySet<string>,
): TimelineItem[] {
  const merged = new Map<string, TimelineItem>();
  for (const [index, item] of snapshot.entries()) {
    if (turnIds.has(timelineItemTurnId(item) ?? "")) merged.set(timelineIdentityKey(item, index), item);
  }
  for (const [index, item] of live.entries()) {
    if (!turnIds.has(timelineItemTurnId(item) ?? "")) continue;
    const key = timelineIdentityKey(item, index);
    const current = merged.get(key);
    merged.set(key, current ? preferTimelineItem(current, item) : item);
  }
  return [...merged.values()].sort((a, b) => (
    a.timestamp - b.timestamp || (timelineItemSeq(a) ?? 0) - (timelineItemSeq(b) ?? 0)
  ));
}

export function latestTaskMap(tasks: TaskUpdate[]): Map<string, TaskUpdate> {
  const latest = new Map<string, TaskUpdate>();
  for (const task of tasks) {
    const previous = latest.get(task.task_id);
    if (!previous || task.timestamp >= previous.timestamp) latest.set(task.task_id, task);
  }
  return latest;
}

export function planProgress(plan: PlanStartedUpdate | null | undefined, tasks: TaskUpdate[]) {
  const total = plan?.phases.length ?? 0;
  if (!plan) return { completed: 0, total };
  const latest = latestTaskMap(tasks);
  return {
    completed: plan.phases.filter((phase) => latest.get(phase.taskId)?.status === "completed").length,
    total,
  };
}

export function projectRunPresentation(
  turnIds: ReadonlySet<string>,
  timeline: TimelineItem[],
): RunPresentationModel {
  const items = timeline.filter((item) => turnIds.has(timelineItemTurnId(item) ?? ""));
  const plan = (items.filter((item) => item.type === "plan_started").at(-1)?.data as PlanStartedUpdate | undefined) ?? null;
  const taskById = latestTaskMap(items
    .filter((item) => item.type === "task_update")
    .map((item) => item.data as TaskUpdate));
  const tasks = [...taskById.values()].sort((a, b) => a.timestamp - b.timestamp);
  const reasoning = items.flatMap((item): RunReasoningPass[] => {
    if (item.type !== "message") return [];
    const value = (item.data as ChatMessage).reasoning;
    if (!value) return [];
    return [{
      provider: value.provider,
      ...(value.summary?.trim() ? { summary: value.summary.trim() } : {}),
      ...(value.hasPrivateReasoning ? { hasPrivateReasoning: true } : {}),
      streaming: value.streaming,
      startedAt: value.startedAt,
      ...(value.completedAt != null ? { completedAt: value.completedAt } : {}),
      ...(value.durationMs != null ? { durationMs: value.durationMs } : {}),
    }];
  });
  const artifactById = new Map<string, Artifact>();
  for (const item of items) {
    if (item.type !== "artifact") continue;
    const artifact = item.data as Artifact;
    artifactById.set(artifact.id, artifact);
  }
  const artifacts = [...artifactById.values()];
  const toolCalls = new Set(items
    .filter((item) => item.type === "tool_event")
    .map((item) => (item.data as ToolEvent).callId)
    .filter(Boolean)).size;
  return {
    items,
    plan,
    tasks,
    taskById,
    progress: planProgress(plan, tasks),
    reasoning,
    artifacts,
    metrics: { reasoningPasses: reasoning.length, toolCalls, outputs: artifacts.length },
  };
}

export function runMetrics(turnIds: ReadonlySet<string>, timeline: TimelineItem[]) {
  return projectRunPresentation(turnIds, timeline).metrics;
}
