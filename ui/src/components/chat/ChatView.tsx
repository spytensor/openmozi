import { useCallback, useRef, useEffect, useLayoutEffect, useMemo, useState, type KeyboardEvent, type ReactNode, type UIEvent } from "react";
import { ArrowDown, ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TimelineItem, ChatMessage, ApprovalRequest, Artifact, MemoryUpdate, PlanStartedUpdate, SessionState, TurnEnvelope } from "@/types";
import MessageBubble, { AssistantNarration, hasRenderableAssistantContent, stripInjectedContext } from "./MessageBubble";
import MoziAvatar from "@/components/MoziAvatar";
import ExecutionBlock, { TechnicalDetails, type OpenSourcesHandler } from "./ExecutionBlock";
import type { ExecutionBlockModel, ExecutionSourceRef } from "./execution";
import ApprovalCard from "./ApprovalCard";
import ArtifactCard from "./ArtifactCard";
import InlineVisualCard, { isInlineVisualArtifact } from "./InlineVisualCard";
import SupportingFilesGroup from "./SupportingFilesGroup";
import { buildExecutionBlockModel, buildExecutionIssueSummaries, isCancelledTask, isExecutionTimelineItem, toolRunningActionLabel, type ChatRenderItem } from "./execution";
import { canProjectDeterministically, projectLegacyTimeline, projectTimelineByTurn } from "./turn-projection";
import { MemoryUpdateNotice } from "./MemoryUpdateNotice";
import { translateMessage, useLocale, type MessageKey } from "@/i18n";

const WELCOME_SUGGESTIONS: MessageKey[] = [
  "chat.card.research.prompt",
  "chat.card.code.prompt",
  "chat.card.writing.prompt",
];

const AUTO_FOLLOW_THRESHOLD_PX = 48;

function AssistantColumnRow({ children, showAvatar = false }: { children: ReactNode; showAvatar?: boolean }) {
  return (
    <div data-testid="chat-assistant-column-row" className="flex w-full max-w-full items-start gap-3">
      {showAvatar ? (
        <MoziAvatar className="mt-0.5" />
      ) : (
        <div data-testid="chat-assistant-column-spacer" aria-hidden="true" className="mt-0.5 h-[26px] w-[26px] shrink-0" />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/**
 * The live "MOZI is doing X" line shown while a tool runs but no live execution
 * block sits at the timeline bottom. It stays a compact one-liner by default,
 * but — when the active turn has already completed steps that are otherwise held
 * back during the turn — it becomes clickable to reveal those step details, so
 * a user who wants to see what's happening can, without cluttering the default.
 */
function LiveToolLine({
  label,
  detailBlocks,
}: {
  label: string;
  detailBlocks: Array<Extract<ChatRenderItem, { kind: "execution" }>["block"]>;
}) {
  const [open, setOpen] = useState(false);
  const canExpand = detailBlocks.length > 0;
  return (
    <div data-testid="chat-active-tool-line" className="w-full max-w-[640px]">
      <button
        type="button"
        onClick={() => canExpand && setOpen((value) => !value)}
        aria-expanded={canExpand ? open : undefined}
        className={cn(
          "flex w-full items-center gap-2 py-1.5 text-[12px] leading-none text-ink/42 transition-colors",
          canExpand ? "cursor-pointer hover:text-ink/60" : "cursor-default",
        )}
      >
        <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-activity" strokeWidth={2} />
        <span className="live-verb-shimmer min-w-0 truncate">{label}</span>
        {canExpand && (
          <ChevronDown
            size={12}
            className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", open && "rotate-180")}
          />
        )}
      </button>
      {open && canExpand && (
        <div className="mt-2 space-y-3 border-l border-ink/[0.07] pl-3 duration-180ms motion-safe:animate-in motion-safe:fade-in-0">
          {detailBlocks.map((block) => (
            <ExecutionBlock key={block.key} block={block} embedded />
          ))}
        </div>
      )}
    </div>
  );
}

/** The clean text of the nearest user message before `index`, or undefined. */
function precedingUserPrompt(timeline: TimelineItem[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "message") continue;
    const m = item.data as ChatMessage;
    if (m.role !== "user") continue;
    const text = stripInjectedContext(m.content);
    return text.trim() ? text : undefined;
  }
  return undefined;
}

function precedingProjectedUserPrompt(renderItems: ChatRenderItem[], index: number): string | undefined {
  for (let i = index - 1; i >= 0; i--) {
    const item = renderItems[i];
    if (item.kind !== "single" || item.item.type !== "message") continue;
    const message = item.item.data as ChatMessage;
    if (message.role === "user") return stripInjectedContext(message.content);
  }
  return undefined;
}

function isStreamingAssistantAnswer(item?: TimelineItem): boolean {
  if (item?.type !== "message") return false;
  const message = item.data as ChatMessage;
  return message.role === "assistant" && message.streaming === true && hasRenderableAssistantContent(message);
}

function isStreamingAssistantMessage(item?: TimelineItem): boolean {
  if (item?.type !== "message") return false;
  const message = item.data as ChatMessage;
  return message.role === "assistant" && message.streaming === true;
}

function normalizedArtifactState(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isArtifactTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "closed" || status === "cancelled" || status === "canceled";
}

function isRunningArtifact(artifact: Artifact): boolean {
  const status = normalizedArtifactState(artifact.status);
  if (status === "running" || status === "generating") return true;
  if (isArtifactTerminalStatus(status)) return false;

  const dataStatus = normalizedArtifactState(artifact.data.status);
  if (dataStatus === "running" || dataStatus === "generating") return true;

  const phase = normalizedArtifactState(artifact.data.phase);
  return artifact.plugin_id === "live_work_v1" && (phase === "generating" || phase === "writing");
}

const GENERATED_ARTIFACT_DIRECTORIES = new Set([
  "target",
  "build",
  "dist",
  "out",
  "coverage",
  "cache",
  "tmp",
  "temp",
  "node_modules",
]);

/**
 * Machine noise that is not user output at all (build metadata, cache markers).
 * Distinct from `supporting` files, which are real output shown collapsed.
 */
function isIntermediateFileArtifact(artifact: Artifact): boolean {
  if (artifact.plugin_id !== "file_v1") return false;
  const filename = String(artifact.data.filename ?? artifact.title ?? "").toLowerCase();
  const path = String(artifact.data.path ?? "");
  const segments = path.split(/[\\/]+/).map((segment) => segment.toLowerCase());
  return segments.some((segment) => GENERATED_ARTIFACT_DIRECTORIES.has(segment))
    || filename === "invoked.timestamp"
    || filename === "cachedir.tag"
    || filename.endsWith(".d")
    || /^build_script_build-[a-f0-9]+\./.test(filename)
    || /^generate[_-].*\.(?:js|mjs|cjs|ts|py|sh)$/.test(filename);
}

/**
 * A file the backend marked as produced on the way to the turn's deliverable.
 * Build/cache noise is excluded here as well as on the normal row path, so
 * collapsing never resurfaces something that was hidden outright.
 */
/** A resolved (non-pending) approval row — eligible for same-turn dedup. */
function isResolvedApproval(item: ChatRenderItem): boolean {
  if (item.kind !== "single" || item.item.type !== "approval_request") return false;
  return (item.item.data as ApprovalRequest).status !== "pending";
}

/**
 * Dedup identity for resolved approvals: same turn, same KIND of ask, same
 * outcome. Deliberately excludes the description: it is path/command-specific
 * server-side while the resolved line renders only the generic action label,
 * so two different-path grants in one turn are visually identical noise — the
 * underlying approvals stay durable records either way. Returns null when the
 * approval has no turn identity (e.g. l3_grant): without a turn boundary the
 * merge would silently span the whole session.
 */
function approvalSignature(item: TimelineItem): string | null {
  const approval = item.data as ApprovalRequest;
  const turn = item.turnId ?? approval.turnId;
  if (!turn) return null;
  return `${turn}|${approval.action ?? ""}|${approval.status}`;
}

/**
 * The runtime's canned detach-handoff wording (src/core/dag-bridge.ts
 * `buildDetachedPlanUserMessage`) — kept in sync by shape, not import: the
 * runtime owns the string, the UI only recognizes it. If the wording changes,
 * the sentence shows again (fail-open) instead of ever hiding a real answer.
 */
const DETACHED_PLAN_HANDOFF_PATTERNS = [
  /^已将任务分解为 \d+ 步计划并开始后台执行/,
  /^I broke this down into a \d+-step plan now running in the background/,
];

function isSupportingArtifact(item: ChatRenderItem): boolean {
  if (item.kind !== "single" || item.item.type !== "artifact") return false;
  const artifact = item.item.data as Artifact;
  // Role is the server-authoritative deliverable contract (Issue #735) and is
  // deliberately not gated on plugin id: `document_v1` and `file_v1` follow one
  // grouping rule, so any deliverable the backend demoted collapses here.
  return artifact.data.role === "supporting"
    && !isIntermediateFileArtifact(artifact);
}


function latestUserMessageIndex(timeline: TimelineItem[]): number {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type !== "message") continue;
    const message = item.data as ChatMessage;
    if (message.role === "user") return i;
  }
  return 0;
}

function hasRunningArtifactInCurrentTurn(timeline: TimelineItem[]): boolean {
  const start = latestUserMessageIndex(timeline);
  for (let i = start; i < timeline.length; i++) {
    const item = timeline[i];
    if (item.type === "artifact" && isRunningArtifact(item.data as Artifact)) return true;
  }
  return false;
}

function messageTurnId(message: ChatMessage): string | undefined {
  return message.turnId?.trim() || undefined;
}

function sameTurnBeforeNextUser(currentTurnId: string | undefined, laterTurnId: string | undefined): boolean {
  if (currentTurnId && laterTurnId) return currentTurnId === laterTurnId;
  // Current runtime data does not reliably attach turnId to assistant text, so
  // missing IDs fall back to the user-message boundary.
  return true;
}

function isRenderableAssistantText(item: TimelineItem): boolean {
  if (item.type !== "message") return false;
  const message = item.data as ChatMessage;
  return message.role === "assistant" && hasRenderableAssistantContent(message);
}

function hasLaterTurnWork(renderItems: ChatRenderItem[], renderIndex: number, message: ChatMessage): boolean {
  const currentTurnId = messageTurnId(message);

  for (let i = renderIndex + 1; i < renderItems.length; i++) {
    const next = renderItems[i];

    if (next.kind === "execution") {
      if (next.block.status === "running" && sameTurnBeforeNextUser(currentTurnId, next.block.turnId)) return true;
      continue;
    }

    const item = next.item;
    if (item.type !== "message") continue;
    const nextMessage = item.data as ChatMessage;
    if (nextMessage.role === "user") break;
    if (isRenderableAssistantText(item) && sameTurnBeforeNextUser(currentTurnId, messageTurnId(nextMessage))) {
      return true;
    }
  }

  return false;
}

function isLastAssistantTextInTurn(renderItems: ChatRenderItem[], renderIndex: number, message: ChatMessage): boolean {
  if (message.role !== "assistant" || !hasRenderableAssistantContent(message)) return true;
  return !hasLaterTurnWork(renderItems, renderIndex, message);
}

type ActivityIndicatorKind = "none" | "tool" | "responding" | "thinking" | "working";

function hasLiveExecutionBlock(renderItems: ChatRenderItem[], activeTurnId: string | null): boolean {
  // Structural (not positional) guard: a mounted running execution block owns
  // liveness — it renders its own live line, so the extra indicator must yield
  // even when later narration pushed the block above the timeline bottom.
  // Scoped to the ACTIVE turn: an orphaned "running" block from an earlier
  // turn (missing end frame, envelope not yet applied) must not silence the
  // indicator for the turn actually working now.
  return renderItems.some(
    (ri) =>
      ri.kind === "execution" &&
      ri.block.status === "running" &&
      (!activeTurnId || !ri.block.turnId || ri.block.turnId === activeTurnId),
  );
}

/**
 * Derives the single extra activity indicator for the chat rail.
 * Invariant: at most ONE indicator renders at any time. Any visible activity
 * already at the bottom of the timeline - growing streaming answer text, a
 * running execution block, a running artifact card - IS the activity signal, so the extra
 * indicator must be "none" in those states.
 */
function deriveActivityIndicator(
  timeline: TimelineItem[],
  renderItems: ChatRenderItem[],
  sessionState: SessionState,
  activeTool: string | null,
  activeTurnId: string | null,
): ActivityIndicatorKind {
  if (sessionState === "IDLE") return "none";

  const lastItem = timeline[timeline.length - 1];
  if (hasLiveExecutionBlock(renderItems, activeTurnId)) return "none";
  if (activeTool) return "tool";
  if (isStreamingAssistantAnswer(lastItem)) return "none";
  if (isStreamingAssistantMessage(lastItem)) return "responding";
  if (hasRunningArtifactInCurrentTurn(timeline)) return "none";
  // "Thinking" is honest only before the turn has produced anything. Once the
  // turn has narrated or run tools, the between-steps gap (often a long one
  // while the model composes its next tool call) reads as continued work.
  return hasTurnOutputSinceLastUserMessage(timeline) ? "working" : "thinking";
}

/** True once the active turn has any visible narration or concrete work behind it. */
function hasTurnOutputSinceLastUserMessage(timeline: TimelineItem[]): boolean {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "message") {
      const msg = item.data as ChatMessage;
      if (msg.role === "user") return false;
      if (msg.role === "assistant" && (msg.content ?? "").trim()) return true;
      continue;
    }
    if (item.type === "tool_event" || item.type === "task_update" || item.type === "plan_started" || item.type === "artifact") return true;
  }
  return false;
}

/**
 * Max render rows mounted at once before the earlier prefix is windowed out
 * (Issue #628). Chosen well above a typical session so ordinary chats render
 * unchanged; only very long sessions pay the DOM cost of a hidden prefix.
 */
const WINDOW_MAX_ROWS = 160;

function isUserRenderRow(item: ChatRenderItem): boolean {
  return item.kind === "single" && item.item.type === "message" && (item.item.data as ChatMessage).role === "user";
}

function renderTurnId(item: ChatRenderItem): string | undefined {
  if (item.kind === "execution") return item.block.turnId;
  const value = item.item.turnId ?? (item.item.data as { turnId?: unknown } | undefined)?.turnId;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * First render-row index to mount, keeping the last `cap` rows but backing up to
 * the nearest user-message boundary so a turn is never split (preserving the
 * per-turn avatar/ordering invariants). Returns 0 when nothing is windowed.
 */
function windowStartIndex(renderItems: ChatRenderItem[], cap: number): number {
  if (renderItems.length <= cap) return 0;
  let start = renderItems.length - cap;
  const turnId = renderTurnId(renderItems[start]);
  if (turnId) {
    while (start > 0 && renderTurnId(renderItems[start - 1]) === turnId) start -= 1;
    return start;
  }
  while (start > 0 && !isUserRenderRow(renderItems[start])) start -= 1;
  return start;
}

type LiveActivity = "idle" | "working" | "thinking" | "responding" | "approval";

// Dedicated screen-reader phrasing, distinct from the visible `chat.status.*`
// indicators so assistive tech announces a clear full phrase and the two never
// double-read the same text.
const LIVE_ACTIVITY_KEY: Record<Exclude<LiveActivity, "idle">, MessageKey> = {
  working: "chat.activity.working",
  thinking: "chat.activity.thinking",
  responding: "chat.activity.responding",
  approval: "chat.activity.approval",
};

/**
 * Collapse the fine-grained render state into ONE coarse live-activity phase for
 * screen readers (Issue #628). Announcing this (and only this) means assistive
 * tech hears "Working" / "Responding" / "Waiting for your approval" once per
 * transition — never one announcement per low-level tool event.
 */
function deriveLiveActivity(
  activityIndicator: ActivityIndicatorKind,
  renderItems: ChatRenderItem[],
  sessionState: SessionState,
  turns?: TurnEnvelope[],
): LiveActivity {
  if (turns?.some((turn) => turn.status === "awaiting_approval")) return "approval";
  const last = renderItems[renderItems.length - 1];
  // Only a still-pending approval card is a meaningful "waiting" activity. Once
  // the operator approves or rejects, the card stays the last render item but
  // must no longer make the live region announce "waiting for your approval"
  // (Issue #628).
  if (
    last?.kind === "single" &&
    last.item.type === "approval_request" &&
    (last.item.data as ApprovalRequest).status === "pending"
  ) {
    return "approval";
  }
  if (sessionState === "IDLE") return "idle";
  if (activityIndicator === "responding") return "responding";
  if (activityIndicator === "thinking") return "thinking";
  return "working";
}

interface TurnFoldGroup {
  key: string;
  items: ChatRenderItem[];
}

interface FailedTurnGroup {
  key: string;
  block: ExecutionBlockModel;
}

function mergeExecutionBlocks(blocks: ExecutionBlockModel[], key: string): ExecutionBlockModel {
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const tasks = blocks.flatMap((block) => block.tasks);
  const tools = blocks.flatMap((block) => block.tools);
  const plan = blocks.find((block) => block.plan)?.plan;
  const issueSummaries = buildExecutionIssueSummaries(tasks, tools);
  const planBacked = Boolean(plan) || (first.turnId?.startsWith("turn_bg_") ?? false);
  const issueCount = planBacked
    ? tasks.filter((task) => task.status === "failed" && !isCancelledTask(task)).length
    : issueSummaries.reduce((total, issue) => total + issue.count, 0);
  const hasRunning = blocks.some((block) => block.status === "running");
  const hasError = blocks.some((block) => block.status === "error" || block.status === "mixed");
  const hasSuccess = blocks.some((block) => block.status === "success" || block.status === "mixed");
  const status: ExecutionBlockModel["status"] = hasRunning
    ? "running"
    : hasError && hasSuccess
      ? "mixed"
      : hasError
        ? "error"
        : blocks.every((block) => block.status === "cancelled")
          ? "cancelled"
          : blocks.some((block) => block.status === "interrupted")
            ? "interrupted"
            : "success";

  return {
    ...first,
    key,
    headline: last.headline,
    status,
    toolCount: blocks.reduce((total, block) => total + block.toolCount, 0),
    taskCount: tasks.length,
    issueCount,
    totalElapsedMs: blocks.reduce((total, block) => total + block.totalElapsedMs, 0),
    issueSummaries,
    tasks,
    tools,
    plan,
  };
}

/**
 * A terminally failed TURN owns one visible process surface. Assistant narration
 * can split its execution stream into several render blocks, but those blocks
 * are child operations of the same turn — rendering each as its own capsule
 * shatters both the task identity and the page.
 */
function buildFailedTurnGroups(
  renderItems: ChatRenderItem[],
  failedTurnIds: ReadonlySet<string>,
  startIndex: number,
): { groups: Map<number, FailedTurnGroup>; grouped: Set<number> } {
  const byTurn = new Map<string, { indices: number[]; blocks: ExecutionBlockModel[] }>();
  for (let i = startIndex; i < renderItems.length; i++) {
    const item = renderItems[i];
    if (item.kind !== "execution" || !item.block.turnId || !failedTurnIds.has(item.block.turnId)) continue;
    const bucket = byTurn.get(item.block.turnId) ?? { indices: [], blocks: [] };
    bucket.indices.push(i);
    bucket.blocks.push(item.block);
    byTurn.set(item.block.turnId, bucket);
  }

  const groups = new Map<number, FailedTurnGroup>();
  const grouped = new Set<number>();
  for (const [turnId, bucket] of byTurn) {
    const anchor = bucket.indices[0];
    groups.set(anchor, {
      key: `failed-turn-${turnId}`,
      block: mergeExecutionBlocks(bucket.blocks, `failed-turn-${turnId}`),
    });
    bucket.indices.forEach((index) => grouped.add(index));
  }
  return { groups, grouped };
}

/**
 * Every turn id a fold speaks for. A detached plan's execution streams under
 * its own `turn_bg_<planId>` turn while `plan_started` stays on the foreground
 * turn — the fold claims BOTH, or the bg turn's supporting files and product
 * index leak out as chat rows beside the fold that narrates them.
 */
function foldClaimedTurnIds(items: ChatRenderItem[]): string[] {
  const ids = new Set<string>();
  for (const ri of items) {
    const turn = renderTurnId(ri);
    if (turn) ids.add(turn);
    if (ri.kind === "execution" && ri.block.plan?.plan_id) ids.add(`turn_bg_${ri.block.plan.plan_id}`);
  }
  return [...ids];
}

function isUserMessageRow(ri: ChatRenderItem): boolean {
  return ri.kind === "single" && ri.item.type === "message" && (ri.item.data as ChatMessage).role === "user";
}

function isAssistantTextRow(ri: ChatRenderItem): boolean {
  return (
    ri.kind === "single" &&
    ri.item.type === "message" &&
    (ri.item.data as ChatMessage).role === "assistant" &&
    hasRenderableAssistantContent(ri.item.data as ChatMessage)
  );
}

function isFoldableRow(ri: ChatRenderItem, failedTurnIds: ReadonlySet<string>): boolean {
  // Everything the turn worked THROUGH before its latest answer is process,
  // including phases with survived errors (the turn moved past them and still
  // delivered — they fold, and the completed turn reads as done). What never
  // folds: running work, cancellations/interruptions (no later answer
  // supersedes them), approvals, deliverable artifacts, and any block of a
  // turn whose ENVELOPE is failed — hard failure owns its own surface
  // (presentation matrix), and terminal truth comes from the envelope, never
  // from block shape.
  if (ri.kind === "execution") {
    if (ri.block.turnId && failedTurnIds.has(ri.block.turnId)) return false;
    return ri.block.status === "success" || ri.block.status === "error" || ri.block.status === "mixed";
  }
  const turnId = renderTurnId(ri);
  if (turnId && failedTurnIds.has(turnId)) return false;
  return isAssistantTextRow(ri);
}

/**
 * Collapse a turn's intermediate process — interim narration and completed
 * work phases BEFORE its latest answer — into one quiet disclosure, so the
 * final answer is the only full-size content a finished turn leaves behind.
 * Grouping is per user-message segment; the newest assistant message (the
 * answer, or the narration currently being worked under) never folds.
 */
function buildTurnFolds(renderItems: ChatRenderItem[], failedTurnIds: ReadonlySet<string>): { groups: Map<number, TurnFoldGroup>; folded: Set<number> } {
  const groups = new Map<number, TurnFoldGroup>();
  const folded = new Set<number>();

  const flushSegment = (start: number, end: number) => {
    let lastAssistant = -1;
    for (let i = end - 1; i >= start; i--) {
      if (isAssistantTextRow(renderItems[i])) {
        lastAssistant = i;
        break;
      }
    }
    if (lastAssistant < 0) return;
    const collected: number[] = [];
    for (let i = start; i < lastAssistant; i++) {
      if (isFoldableRow(renderItems[i], failedTurnIds)) collected.push(i);
    }
    // A scheduled plan's caller-owned delivery can arrive under a separate
    // background message turn before the stable `turn_bg_<planId>` execution
    // turn is ordered into the client. The assistant row is still the answer;
    // pull the plan's existing child execution into its foreground fold instead
    // of leaving a second standalone "View work" disclosure after the answer.
    const linkedPlanTurns = new Set(
      collected.flatMap((index) => {
        const item = renderItems[index];
        const planId = item.kind === "execution" ? item.block.plan?.plan_id : undefined;
        return planId ? [`turn_bg_${planId}`] : [];
      }),
    );
    if (linkedPlanTurns.size > 0) {
      for (let i = lastAssistant + 1; i < end; i++) {
        const item = renderItems[i];
        if (
          item.kind === "execution" &&
          item.block.turnId &&
          linkedPlanTurns.has(item.block.turnId) &&
          isFoldableRow(item, failedTurnIds)
        ) {
          collected.push(i);
        }
      }
    }
    if (collected.length === 0) return;
    groups.set(collected[0], {
      key: `turn-fold-${collected[0]}`,
      items: collected.map((i) => renderItems[i]),
    });
    collected.forEach((i) => folded.add(i));
  };

  let segStart = 0;
  for (let i = 0; i <= renderItems.length; i++) {
    if (i === renderItems.length || isUserMessageRow(renderItems[i])) {
      flushSegment(segStart, i);
      segStart = i + 1;
    }
  }

  return { groups, folded };
}

function foldItemTimestamps(ri: ChatRenderItem): number[] {
  if (ri.kind === "execution") {
    return [...ri.block.tools, ...ri.block.tasks].map((entry) => entry.timestamp).filter((ts) => ts > 1_000_000_000_000);
  }
  return ri.item.timestamp > 1_000_000_000_000 ? [ri.item.timestamp] : [];
}

function TurnFold({
  group,
  onOpenSources,
  supportingArtifacts,
  artifactsTotal,
  onOpenArtifact,
  onViewAllArtifacts,
}: {
  group: TurnFoldGroup;
  onOpenSources?: OpenSourcesHandler;
  /**
   * The turn's supporting files, housed HERE rather than as chat rows
   * (operator decision 2026-07-19, UCI Online Retail incident: a "68 个过程
   * 文件" disclosure rendered as a chat row under the report — process files
   * are process, so they live inside 查看处理过程 with the rest of it).
   */
  supportingArtifacts?: Artifact[];
  artifactsTotal?: number;
  onOpenArtifact?: (artifact: Artifact) => void;
  onViewAllArtifacts?: () => void;
}) {
  const { locale: uiLocale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const locale = uiLocale;

  const mergedTechnicalBlock = useMemo<ExecutionBlockModel | null>(() => {
    const blocks = group.items
      .filter((ri): ri is ChatRenderItem & { kind: "execution" } => ri.kind === "execution")
      .map((ri) => ri.block);
    if (blocks.length === 0) return null;
    const merged = blocks[0];
    return {
      ...merged,
      plan: blocks.find((block) => block.plan)?.plan,
      tools: blocks.flatMap((block) => block.tools),
      tasks: blocks.flatMap((block) => block.tasks),
    };
  }, [group.items]);
  // A plan-driven turn folds into ONE merged plan card (partial per-block
  // cards rendered "2/3" and "1/3" stacked — nonsense to the reader). The
  // merged model is rendered once at the first execution position; narration
  // keeps its chronological place around it.
  const foldHasPlan = Boolean(mergedTechnicalBlock?.plan);
  let mergedCardRendered = false;

  const stamps = group.items.flatMap(foldItemTimestamps);
  const spanMs = stamps.length >= 2 ? Math.max(...stamps) - Math.min(...stamps) : 0;
  const minutes = spanMs >= 60_000 ? Math.max(1, Math.floor(spanMs / 60_000)) : 0;
  const label = minutes > 0
    ? `${translateMessage(locale, "execution.summary.viewWork")} · ${translateMessage(locale, "execution.duration.minutes", { count: String(minutes) })}`
    : translateMessage(locale, "execution.summary.viewWork");
  return (
    <div data-testid="turn-fold" className="w-full max-w-[640px] py-1">
      <button
        type="button"
        data-testid="turn-fold-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex max-w-full items-center gap-2 px-1 py-1 text-[12px] leading-none text-ink/35 transition-colors duration-180ms hover:text-ink/55"
      >
        {/* By construction the fold only exists once the turn produced its final
            answer (buildTurnFolds requires a lastAssistant), so it always
            represents a completed turn. Survived mid-turn errors are normal
            process, not a failure — the dot is green ("done"), never amber. */}
        <span
          data-testid="turn-fold-done-dot"
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-success/80"
        />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", expanded && "rotate-180")} />
      </button>
      {expanded && (
        <div
          data-testid="turn-fold-content"
          className="mt-2.5 space-y-3 border-l border-ink/[0.07] pl-3 duration-180ms motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
        >
          {group.items.map((ri, idx) => {
            if (ri.kind !== "execution") {
              return <AssistantNarration key={(ri.item.data as ChatMessage).id ?? `narration-${idx}`} message={ri.item.data as ChatMessage} />;
            }
            if (foldHasPlan && mergedTechnicalBlock) {
              if (mergedCardRendered) return null;
              mergedCardRendered = true;
              return <ExecutionBlock key={`merged-${mergedTechnicalBlock.key}`} block={mergedTechnicalBlock} embedded suppressTechnicalDetails onOpenSources={onOpenSources} />;
            }
            return <ExecutionBlock key={ri.block.key} block={ri.block} embedded suppressTechnicalDetails onOpenSources={onOpenSources} />;
          })}
          {supportingArtifacts && supportingArtifacts.length > 0 && (
            <SupportingFilesGroup artifacts={supportingArtifacts} onOpen={onOpenArtifact} />
          )}
          {(artifactsTotal ?? 0) > 1 && onViewAllArtifacts && (
            <button
              type="button"
              data-testid="chat-view-all-artifacts"
              onClick={onViewAllArtifacts}
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-ink/40 transition-colors hover:bg-ink/[0.04] hover:text-ink/65"
            >
              {translateMessage(locale, "chat.artifacts.viewAll", { count: artifactsTotal })}
              <ChevronDown className="h-3 w-3 -rotate-90" aria-hidden="true" />
            </button>
          )}
          {/* One Technical details for the whole turn — narration splits the
              process into several blocks, but the raw tool dump is a single
              per-turn appendix, not a per-fragment repeat. */}
          {mergedTechnicalBlock && <TechnicalDetails block={mergedTechnicalBlock} locale={locale} />}
        </div>
      )}
    </div>
  );
}

function renderRowKey(ri: ChatRenderItem, index: number): string {
  if (ri.kind === "execution") return `exec-${ri.block.key}`;
  const item = ri.item;
  if (item.type === "message") return `msg-${(item.data as ChatMessage).id ?? index}`;
  if (item.type === "approval_request") return `apr-${(item.data as ApprovalRequest).id ?? index}`;
  if (item.type === "artifact") return `art-${(item.data as Artifact).id ?? index}`;
  if (item.type === "memory_update") return `memory-${item.turnId ?? index}`;
  return `row-${index}`;
}

interface ChatViewProps {
  sessionId?: string | null;
  timeline: TimelineItem[];
  sessionState: SessionState;
  activeTool: string | null;
  activeToolSkillName?: string | null;
  /** Turn currently running per the runtime (null = nothing is running). */
  activeTurnId?: string | null;
  /** Timeline capabilities advertised by the server; gates deterministic projection. */
  timelineCapabilities?: string[];
  /** Server-authoritative turn envelopes for terminal-state consumption. */
  turns?: TurnEnvelope[];
  onApprove: (id: string, scope?: "once" | "session") => void;
  onReject: (id: string) => void;
  onSend: (content: string) => void;
  onRegenerate: (content: string) => void;
  onDeleteMessage?: (message: ChatMessage) => void;
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenModelSettings?: () => void;
  onOpenMemory?: () => void;
  /** Older timeline pages exist beyond what is loaded (server hasMore). */
  hasOlderHistory?: boolean;
  /** An older page is currently being fetched. */
  loadingOlderHistory?: boolean;
  /** Fetch the next older page. Triggered by scrolling near the top. */
  onLoadOlderHistory?: () => void;
}

/** Scrolling within this many px of the top pulls the next older history page. */
const OLDER_HISTORY_TRIGGER_PX = 240;

export default function ChatView({ sessionId = null, timeline, sessionState, activeTool, activeToolSkillName = null, activeTurnId = null, timelineCapabilities, turns, onApprove, onReject, onSend, onRegenerate, onDeleteMessage, onOpenArtifact, onOpenModelSettings, onOpenMemory, hasOlderHistory = false, loadingOlderHistory = false, onLoadOlderHistory }: ChatViewProps) {
  const { locale, t } = useLocale();
  const scrollRegionRef = useRef<HTMLDivElement>(null);
  const autoFollowRef = useRef(true);
  const [autoFollow, setAutoFollow] = useState(true);
  // Upward infinite scroll (operator decision 2026-07-18: history loads as you
  // scroll — the user never sees a "load more" pagination control). One
  // request per approach to the top; the anchor keeps the viewport pinned to
  // the row the user was reading while older rows prepend above it.
  const olderRequestedRef = useRef(false);
  const olderAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  // "View all N sources" on an aggregated activity row opens the workbench
  // panel with a client-synthesized sources_v1 artifact — the evidence list is
  // already in the timeline's tool events; nothing extra is persisted.
  const handleOpenSources = useCallback<OpenSourcesHandler>((sources: ExecutionSourceRef[], label: string) => {
    if (!onOpenArtifact) return;
    onOpenArtifact({
      id: `sources:${label}:${sources.length}`,
      plugin_id: "sources_v1",
      title: label || t("artifact.sources.title"),
      status: "completed",
      data: { sources },
      timestamp: Date.now(),
    });
  }, [onOpenArtifact, t]);

  const updateAutoFollow = (next: boolean) => {
    autoFollowRef.current = next;
    setAutoFollow(next);
  };

  const scrollToLatest = () => {
    const region = scrollRegionRef.current;
    if (!region) return;
    updateAutoFollow(true);
    region.scrollTo({ top: region.scrollHeight, behavior: "auto" });
  };

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const region = event.currentTarget;
    const distanceFromBottom = region.scrollHeight - region.scrollTop - region.clientHeight;
    const next = distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX;
    if (next !== autoFollowRef.current) updateAutoFollow(next);
    // While auto-follow is on the user is NOT reading history — mount-time
    // scroll events fire with scrollTop still near 0 before the initial
    // scroll-to-bottom lands, and without this gate opening a long session
    // silently pulled the next page every time (observed live). The one
    // exception: content too short to fill the viewport cannot be scrolled at
    // all, so older pages keep loading until there is something to scroll.
    const contentFillsViewport = region.scrollHeight > region.clientHeight + OLDER_HISTORY_TRIGGER_PX;
    if (
      hasOlderHistory
      && !!onLoadOlderHistory
      && !loadingOlderHistory
      && !olderRequestedRef.current
      && region.scrollTop < OLDER_HISTORY_TRIGGER_PX
      && (!autoFollowRef.current || !contentFillsViewport)
    ) {
      olderRequestedRef.current = true;
      olderAnchorRef.current = { scrollHeight: region.scrollHeight, scrollTop: region.scrollTop };
      onLoadOlderHistory();
    }
  };

  // Keep the viewport anchored while an older page prepends: without this the
  // browser keeps scrollTop, so the content the user was reading jumps down by
  // the height of the inserted rows.
  useLayoutEffect(() => {
    const anchor = olderAnchorRef.current;
    const region = scrollRegionRef.current;
    if (!anchor || !region) return;
    if (region.scrollHeight !== anchor.scrollHeight) {
      region.scrollTop = anchor.scrollTop + (region.scrollHeight - anchor.scrollHeight);
      olderAnchorRef.current = null;
    }
  }, [timeline]);

  // Re-arm the trigger once the fetch settles (also clears a stale anchor when
  // the older page came back empty and no timeline change ever fired).
  useEffect(() => {
    if (!loadingOlderHistory) {
      olderRequestedRef.current = false;
      olderAnchorRef.current = null;
    }
  }, [loadingOlderHistory]);

  // Keyboard navigation across the timeline feed (Issue #628): the ARIA `feed`
  // pattern moves focus between article rows with Up/Down and Home/End. Auto-
  // follow is suspended while the user is navigating with the keyboard so the
  // view does not yank focus away from the row they landed on.
  const handleFeedKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const region = scrollRegionRef.current;
    if (!region) return;
    const rows = Array.from(region.querySelectorAll<HTMLElement>("[data-chat-row]"));
    if (rows.length === 0) return;
    const focused = document.activeElement as HTMLElement;
    const current = rows.indexOf(focused);
    // Do not hijack arrow/Home/End behavior from buttons, links, or controls
    // nested inside an article. Feed navigation applies when focus is on the
    // rail itself or directly on one of its article rows.
    if (event.target !== event.currentTarget && current < 0) return;
    let next = current;
    if (event.key === "ArrowDown") next = current < 0 ? 0 : Math.min(rows.length - 1, current + 1);
    else if (event.key === "ArrowUp") next = current < 0 ? rows.length - 1 : Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    const target = rows[next];
    if (!target || next === current) return;
    event.preventDefault();
    if (next < rows.length - 1) updateAutoFollow(false);
    target.focus();
    target.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    const region = scrollRegionRef.current;
    if (!region) return;
    // While an older-history cycle is in flight the user is READING HISTORY:
    // never yank to the bottom, and never let a transient "near bottom" moment
    // (async card hydration growing the content through the threshold after
    // the anchor correction) re-arm follow — that chain ends in a jump to the
    // bottom mid-read (observed live, 2026-07-18).
    const readingHistory = loadingOlderHistory || olderRequestedRef.current || olderAnchorRef.current !== null;
    if (autoFollowRef.current && !readingHistory) {
      region.scrollTo({ top: region.scrollHeight, behavior: "auto" });
    }
    // Re-evaluate "at bottom" on every content change, not only on scroll events.
    // Content can grow or shrink without any scroll (e.g. a short, unscrollable
    // view), which left a stale autoFollow=false pinning the "jump to latest"
    // pill on screen even while the view was already at the bottom — it then
    // only cleared on click. If we are actually at the bottom now, resume follow.
    const distanceFromBottom = region.scrollHeight - region.scrollTop - region.clientHeight;
    if (distanceFromBottom <= AUTO_FOLLOW_THRESHOLD_PX && !autoFollowRef.current && !readingHistory) {
      updateAutoFollow(true);
    }
  }, [timeline.length, timeline[timeline.length - 1], sessionState, loadingOlderHistory]);

  // Hooks must run unconditionally, before the empty-state early return below —
  // React counts hook calls per render (rules of hooks). The projection is
  // memoized here (Issue #628) so it does NOT re-run on unrelated renders — most
  // importantly on every scroll frame (`handleScroll` calls setState). Without
  // this a 500-turn session reprojected + rebuilt every row on each scroll tick.
  const deterministicProjection = canProjectDeterministically(timeline, timelineCapabilities);
  // The detached-plan handoff sentence ("已将任务分解为 N 步计划…" / "I broke
  // this down into…") is runtime-fabricated boilerplate whose entire content
  // the typed plan card already carries — it renders as noise above the plan
  // spine (operator report 2026-07-19). Drop exactly that row: an assistant
  // message in a turn that admitted a plan (has a plan_started row) AND
  // matching the runtime's canned shape. Shape-guarded so a plan turn's real
  // delivery text can never be swallowed; fails open if the runtime wording
  // changes.
  const presentedTimeline = useMemo(() => {
    const planTurns = new Set<string>();
    for (const item of timeline) {
      if (item.type !== "plan_started") continue;
      const turn = item.turnId ?? (item.data as PlanStartedUpdate).turnId;
      if (turn) planTurns.add(turn);
    }
    if (planTurns.size === 0) return timeline;
    return timeline.filter((item) => {
      if (item.type !== "message") return true;
      const message = item.data as ChatMessage;
      if (message.role !== "assistant") return true;
      const turn = item.turnId ?? message.turnId;
      if (!turn || !planTurns.has(turn)) return true;
      return !DETACHED_PLAN_HANDOFF_PATTERNS.some((pattern) => pattern.test(message.content.trim()));
    });
  }, [timeline]);
  const renderItems = useMemo(
    () => (deterministicProjection ? projectTimelineByTurn(presentedTimeline, turns ?? []) : projectLegacyTimeline(presentedTimeline, turns ?? [])),
    [deterministicProjection, presentedTimeline, turns],
  );
  // Windowing state (Issue #628); re-hidden whenever a session shrinks below the
  // cap (session switch / clear) so a new session never inherits an expanded view.
  const [showEarlier, setShowEarlier] = useState(false);
  useEffect(() => {
    if (renderItems.length <= WINDOW_MAX_ROWS) setShowEarlier(false);
  }, [renderItems.length]);
  useEffect(() => {
    setShowEarlier(false);
  }, [sessionId]);

  // Per-turn artifact index (every product incl. workspace working notes) —
  // powers the 查看全部产物 entry under a turn's deliverable card.
  const turnArtifactIndex = useMemo(() => {
    const byTurn = new Map<string, Artifact[]>();
    for (const item of timeline) {
      if (item.type !== "artifact") continue;
      const artifact = item.data as Artifact;
      const turnId = item.turnId ?? artifact.turnId;
      if (!turnId) continue;
      const bucket = byTurn.get(turnId) ?? [];
      bucket.push(artifact);
      byTurn.set(turnId, bucket);
    }
    return byTurn;
  }, [timeline]);

  const handleOpenArtifactsIndex = useCallback((turnId: string | undefined) => {
    if (!turnId || !onOpenArtifact) return;
    const entries = turnArtifactIndex.get(turnId) ?? [];
    if (entries.length === 0) return;
    onOpenArtifact({
      id: `artifacts:${turnId}:${entries.length}`,
      plugin_id: "artifacts_v1",
      title: t("artifact.artifacts.title"),
      status: "completed",
      data: { artifacts: entries },
      timestamp: Date.now(),
    });
  }, [turnArtifactIndex, onOpenArtifact, t]);

  // One STABLE live surface per active turn (mockup contract): narration
  // splits the turn into short-lived blocks, and rendering the card per
  // block made it mount/unmount on every narration — flicker and dead gaps.
  // Instead, all execution events of the active turn consolidate into a
  // single model rendered at one fixed position; it only accumulates rows.
  // NOT plan-only (operator decision 2026-07-18): the four-region model puts
  // ALL of MOZI's working process — plain tool calls included — behind the
  // same working capsule; a plan just adds phases and a progress bar.
  // Hook order: MUST stay above the empty-welcome early return.
  // A detached plan survives session switches through its ENVELOPE, not the
  // foreground FSM: the select_session snapshot deliberately excludes
  // background turns (they must not lock the composer), so after switching
  // back sessionState is IDLE and activeTurnId is null while the plan still
  // runs. The restored envelopes carry the truth — an active background
  // envelope keeps the capsule alive (operator bug report 2026-07-18:
  // "switch away and back, the status vanishes, then comes back later").
  const backgroundLiveTurnId = (turns ?? []).find((turn) => turn.origin === "background" && turn.status === "active")?.turnId ?? null;
  const liveWorkTurnId = sessionState !== "IDLE" && activeTurnId ? activeTurnId : backgroundLiveTurnId;

  const liveTurnWorkModel = useMemo(() => {
    if (!liveWorkTurnId) return null;
    // A detached plan runs under its own turn id (`turn_bg_<planId>`) while
    // plan_started stays on the foreground turn that admitted it — link them
    // by the plan id embedded in the background turn id, or the surface
    // renders a bare tool line with no plan (the exact runtime-truth break
    // the operator saw live).
    const bgPlanId = liveWorkTurnId.startsWith("turn_bg_") ? liveWorkTurnId.slice("turn_bg_".length) : null;
    const turnItems: TimelineItem[] = [];
    let planItem: TimelineItem | null = null;
    for (const item of timeline) {
      if (!isExecutionTimelineItem(item)) continue;
      const turnId = item.turnId ?? (item.data as { turnId?: string } | undefined)?.turnId;
      if (item.type === "plan_started") {
        const planId = (item.data as { plan_id?: string } | undefined)?.plan_id;
        if (turnId === liveWorkTurnId || (bgPlanId != null && planId === bgPlanId)) planItem = item;
        continue;
      }
      if (turnId === liveWorkTurnId) turnItems.push(item);
    }
    if (!planItem && turnItems.length === 0) return null;
    const model = buildExecutionBlockModel(
      planItem ? [planItem, ...turnItems] : turnItems,
      `live-turn-${liveWorkTurnId}`,
      locale,
    );
    // The turn is live by envelope truth here — the card must stay in its
    // live shape between steps instead of flashing a collapsed summary.
    return { ...model, status: "running" as const };
  }, [timeline, liveWorkTurnId, locale]);

  if (timeline.length === 0 && sessionState === "IDLE") {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="w-full max-w-[520px]">
          <div className="mb-7 text-center">
            <div className="mb-3 flex justify-center">
              <MoziAvatar size={48} />
            </div>
            <h1
              className="mb-2 text-[28px] font-semibold leading-tight text-ink/88"
              style={{ fontFamily: '"Kaiti SC","STKaiti",serif, sans-serif' }}
            >
              {t("chat.welcomeHeadline")}
            </h1>
            <p className="text-sm text-ink/36">{t("chat.welcomeSubtitle")}</p>
          </div>
          <div className="divide-y divide-ink/[0.06] border-y border-ink/[0.06]">
            {WELCOME_SUGGESTIONS.map((promptKey) => (
              <button
                key={promptKey}
                onClick={() => onSend(t(promptKey))}
                className="group flex w-full cursor-pointer items-center gap-3 px-1 py-3 text-left text-[13px] text-ink/48 transition-colors duration-150 hover:text-ink/72"
              >
                <span aria-hidden="true" className="text-ink/26 transition-colors group-hover:text-action/70">↗</span>
                <span className="min-w-0 truncate">{t(promptKey)}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Non-hook derivations (safe after the early return). The deterministic Turn
  // projection (Issue #625) is memoized above.
  const activityIndicator = deriveActivityIndicator(timeline, renderItems, sessionState, activeTool, activeTurnId);
  // Turns whose ENVELOPE is terminally failed: their process never folds and
  // keeps one turn-scoped surface. The final assistant message remains the
  // visible failure report; process details open only when the user asks.
  const failedTurnIds = new Set((turns ?? []).filter((turn) => turn.status === "failed").map((turn) => turn.turnId));

  // Windowing (Issue #628): cap mounted DOM rows for very long sessions. The cut
  // is aligned to a user-message boundary so a turn is never split and the
  // per-turn avatar/ordering logic stays correct; chronology is preserved
  // (only a contiguous prefix is hidden, nothing is reordered). Normal-length
  // sessions (<= WINDOW_MAX_ROWS) render byte-for-byte as before.
  const windowStart = showEarlier ? 0 : windowStartIndex(renderItems, WINDOW_MAX_ROWS);
  const hiddenEarlierCount = windowStart;

  // One coarse, deduplicated live-activity phase for screen readers (Issue
  // #628). The DOM text changes only on a phase transition, so an assistive
  // technology announces one meaningful change — never every low-level tool event.
  const liveActivity = deriveLiveActivity(activityIndicator, renderItems, sessionState, turns);
  const liveAnnouncement =
    liveActivity === "idle" ? "" : translateMessage(locale, LIVE_ACTIVITY_KEY[liveActivity]);

  let assistantAvatarShownInTurn = false;

  const claimTurnAvatar = () => {
    const showAvatar = !assistantAvatarShownInTurn;
    assistantAvatarShownInTurn = true;
    return showAvatar;
  };

  const renderActivityIndicator = () => {
    switch (activityIndicator) {
      case "tool": {
        if (!activeTool) return null;
        // The active turn's completed steps are held back from the timeline
        // during the turn (they collapse into the fold once it ends). Offer them
        // as click-to-expand detail behind the live line.
        const detailBlocks = renderItems
          .filter(
            (ri): ri is Extract<ChatRenderItem, { kind: "execution" }> =>
              ri.kind === "execution" && ri.block.turnId === activeTurnId && ri.block.status !== "running",
          )
          .map((ri) => ri.block);
        return (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <LiveToolLine
              label={toolRunningActionLabel(activeTool, locale, activeToolSkillName)}
              detailBlocks={detailBlocks}
            />
          </AssistantColumnRow>
        );
      }
      case "responding":
        return (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <div data-testid="chat-responding-status-line" className="flex items-center gap-2 py-1 text-xs text-ink/40">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-activity" strokeWidth={2} />
              <span>{translateMessage(locale, "chat.status.responding")}</span>
            </div>
          </AssistantColumnRow>
        );
      case "thinking":
      case "working":
        return (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <div data-testid="chat-thinking-indicator" className="flex items-center gap-2 py-1.5">
              <div className="flex items-center gap-2 py-1">
                <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-activity" strokeWidth={2} />
                <span className="text-xs text-ink/40">
                  {translateMessage(locale, activityIndicator === "working" ? "chat.status.working" : "chat.status.thinking")}
                </span>
              </div>
            </div>
          </AssistantColumnRow>
        );
      case "none":
        return null;
    }
  };

  const renderTimelineItem = (ri: ChatRenderItem, renderIndex: number) => {
    if (ri.kind === "execution") {
      // Interruption is server-authoritative. Foreground IDLE is expected after
      // a detached DAG handoff and must never be used to guess that a live
      // background turn died. Startup recovery terminalizes real orphans in
      // the turn envelope; turn projection carries that status into the block.
      // During an active turn the live line is the sole status owner. A terminal
      // disclosure from that same turn is held back until the turn itself is terminal.
      if (sessionState !== "IDLE" && ri.block.status !== "running" && ri.block.turnId === activeTurnId) return null;
      // With the consolidated live plan card active, per-block fragments of
      // the active turn never render — the card is the single live surface.
      if (liveTurnWorkModel && ri.block.turnId === liveWorkTurnId) return null;
      const showAvatar = claimTurnAvatar();
      return (
        <AssistantColumnRow key={ri.block.key} showAvatar={showAvatar}>
          <ExecutionBlock
            block={ri.block}
            onOpenSources={handleOpenSources}
          />
        </AssistantColumnRow>
      );
    }
    const { item, index } = ri;
    switch (item.type) {
      case "message": {
        const msg = item.data as ChatMessage;
        if (msg.role === "user") {
          assistantAvatarShownInTurn = false;
        }
        // An assistant answer regenerates by re-running the user prompt that
        // produced it — the nearest visible user message before it.
        const regenerateText =
          msg.role === "assistant"
            ? deterministicProjection
              ? precedingProjectedUserPrompt(renderItems, renderIndex)
              : precedingUserPrompt(presentedTimeline, index)
            : undefined;
        const assistantMessageRenders =
          msg.role === "assistant" &&
          (hasRenderableAssistantContent(msg) || Boolean(msg.streaming && msg.requestId));
        const showAvatar = msg.role === "assistant" ? !assistantAvatarShownInTurn : true;
        if (assistantMessageRenders) {
          assistantAvatarShownInTurn = true;
        }
        // Stable identity: the timeline is mutated in place (stream upserts,
        // artifact patches, dropped empty messages) — index keys would let
        // React reuse the wrong component instance across those edits.
        return (
          <MessageBubble
            key={msg.id ?? index}
            message={msg}
            onRegenerate={onRegenerate}
            regenerateText={regenerateText}
            showAvatar={showAvatar}
            showAssistantActions={isLastAssistantTextInTurn(renderItems, renderIndex, msg)}
            onDelete={sessionState === "IDLE" && /^conversation:\d+$/.test(msg.id) ? onDeleteMessage : undefined}
            onOpenArtifact={onOpenArtifact}
            onOpenModelSettings={onOpenModelSettings}
          />
        );
      }
      case "approval_request":
        // An approval belongs INSIDE the assistant's turn — align it into
        // the content column (indented past the avatar), not at the avatar's
        // own left edge as a top-level peer.
        return (
          <AssistantColumnRow key={(item.data as ApprovalRequest).id ?? index}>
            <ApprovalCard
              request={item.data as ApprovalRequest}
              onApprove={onApprove}
              onReject={onReject}
            />
          </AssistantColumnRow>
        );
      case "artifact": {
        if (isIntermediateFileArtifact(item.data as Artifact)) return null;
        // Workspace-role artifacts are plan-step working notes: they live in
        // the workbench artifacts view (查看全部产物), never as chat rows.
        if ((item.data as Artifact).data.role === "workspace") return null;
        // While the live plan card runs, the turn's intermediate documents do
        // not parade above it as top-level rows — the card's write steps
        // narrate them; they surface as deliverable/supporting cards when the
        // turn completes.
        const artifactTurn = item.turnId ?? (item.data as Artifact).turnId;
        if (liveTurnWorkModel && artifactTurn === liveWorkTurnId) return null;
        if (isInlineVisualArtifact(item.data as Artifact)) {
          return (
            <AssistantColumnRow key={(item.data as Artifact).id ?? index}>
              <InlineVisualCard artifact={item.data as Artifact} onOpen={onOpenArtifact} />
            </AssistantColumnRow>
          );
        }
        // The completed turn's chat rows are the answer and its deliverable
        // card(s); the product index lives inside the turn's 查看处理过程 fold
        // (operator decision 2026-07-19). ONLY a turn with no visible fold
        // keeps the index under its primary card — without the fallback a
        // fold-less turn (e.g. plan delivery whose execution streamed under
        // another turn id) strands its working notes with no entry at all
        // (review finding 2026-07-19).
        const turnArtifactsCount = artifactTurn ? (turnArtifactIndex.get(artifactTurn)?.length ?? 0) : 0;
        const showIndexFallback = (item.data as Artifact).data.role === "primary"
          && turnArtifactsCount > 1
          && artifactTurn != null
          && !foldVisibleTurns.has(artifactTurn);
        return (
          <AssistantColumnRow key={(item.data as Artifact).id ?? index}>
            <ArtifactCard artifact={item.data as Artifact} onOpen={onOpenArtifact} />
            {showIndexFallback && (
              <button
                type="button"
                data-testid="chat-view-all-artifacts"
                onClick={() => handleOpenArtifactsIndex(artifactTurn)}
                className="mt-1.5 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[12px] text-ink/40 transition-colors hover:bg-ink/[0.04] hover:text-ink/65"
              >
                {translateMessage(locale, "chat.artifacts.viewAll", { count: turnArtifactsCount })}
                <ChevronDown className="h-3 w-3 -rotate-90" aria-hidden="true" />
              </button>
            )}
          </AssistantColumnRow>
        );
      }
      case "memory_update":
        return (
          <AssistantColumnRow key={`memory-${item.turnId ?? index}`}>
            <MemoryUpdateNotice update={item.data as MemoryUpdate} onOpen={onOpenMemory} />
          </AssistantColumnRow>
        );
      default:
        return null;
    }
  };

  // Build the ordered row list once. The live activity indicator always renders
  // at the very bottom of the timeline: with the active turn's terminal blocks
  // held back, the newest narration is the bottom row and the single indicator
  // reads as "what MOZI is doing right now". (The old mid-timeline anchor placed
  // it at the turn's FIRST execution item, which floated a spinner between
  // paragraphs in multi-phase turns.) Windowing drops only a leading prefix;
  // every mounted row is wrapped for keyboard/screen-reader navigation.
  const { groups: turnFoldGroups, folded: foldedRowIndices } = buildTurnFolds(renderItems, failedTurnIds);
  const { groups: failedTurnGroups, grouped: failedTurnRowIndices } = buildFailedTurnGroups(renderItems, failedTurnIds, windowStart);
  const rows: Array<{ key: string; node: ReactNode }> = [];
  // Supporting files are process, not product (operator decision 2026-07-19):
  // a completed turn's chat rows are the answer and its deliverable(s) — the
  // working material lives inside the turn's 查看处理过程 fold. Collected per
  // turn here; the fold render site claims its turns via `foldHousedTurns`,
  // and only turns with no fold at all keep the old inline disclosure row so
  // nothing becomes unreachable.
  const supportingByTurn = new Map<string, Artifact[]>();
  for (const ri of renderItems) {
    if (!isSupportingArtifact(ri)) continue;
    const single = ri as Extract<ChatRenderItem, { kind: "single" }>;
    const turn = single.item.turnId ?? (single.item.data as Artifact).turnId;
    if (turn == null) continue;
    const bucket = supportingByTurn.get(turn) ?? [];
    bucket.push(single.item.data as Artifact);
    supportingByTurn.set(turn, bucket);
  }
  // Turns whose 查看处理过程 fold will ACTUALLY render in the current window.
  // Precomputed — not discovered while iterating — because on the
  // deterministic projection a turn's artifact rows can precede its fold
  // anchor (no execution rows of its own), and order-dependent discovery
  // rendered the files twice: inline row first, then again inside the fold
  // (review finding 2026-07-19). A fold dropped by windowing must not
  // swallow the fallbacks either, or its files become unreachable.
  const foldVisibleTurns = new Set<string>();
  for (const [anchorIndex, group] of turnFoldGroups) {
    if (anchorIndex < windowStart) continue;
    for (const turn of foldClaimedTurnIds(group.items)) foldVisibleTurns.add(turn);
  }
  // Indices already merged into an earlier turn-scoped supporting-files group
  // or deduplicated approval row — they must not render again.
  const consumedSupportingIndices = new Set<number>();
  const consumedApprovalIndices = new Set<number>();
  const pushRow = (ri: ChatRenderItem, index: number) => {
    const node = renderTimelineItem(ri, index);
    if (node) rows.push({ key: renderRowKey(ri, index), node });
  };
  // The working capsule anchors at the TOP of the active turn (four-region
  // order: user message → process capsule → streaming answer/outputs below).
  // Appending it at the timeline tail let the growing answer push it down —
  // "the work card keeps sliding to the bottom" (operator, 2026-07-18).
  let capsulePushed = false;
  const pushLiveCapsule = () => {
    if (capsulePushed || !liveTurnWorkModel) return;
    capsulePushed = true;
    rows.push({
      key: `live-work-${liveWorkTurnId}`,
      node: (
        // -mt pulls the capsule toward the preceding narration: the message's
        // own bottom padding + rail gap read as a fat blank line otherwise
        // (operator feedback 2026-07-18).
        <div className="-mt-1.5">
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <ExecutionBlock block={liveTurnWorkModel} onOpenSources={handleOpenSources} />
          </AssistantColumnRow>
        </div>
      ),
    });
  };
  for (let i = windowStart; i < renderItems.length; i++) {
    // First row that belongs to the active turn and is not the user's own
    // message marks where MOZI's work begins — mount the capsule there.
    if (liveTurnWorkModel && !capsulePushed && renderTurnId(renderItems[i]) === liveWorkTurnId && !isUserRenderRow(renderItems[i])) {
      pushLiveCapsule();
    }
    const failedTurnGroup = failedTurnGroups.get(i);
    if (failedTurnGroup) {
      rows.push({
        key: failedTurnGroup.key,
        node: (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <ExecutionBlock block={failedTurnGroup.block} onOpenSources={handleOpenSources} />
          </AssistantColumnRow>
        ),
      });
      continue;
    }
    if (failedTurnRowIndices.has(i)) continue;
    const foldGroup = turnFoldGroups.get(i);
    if (foldGroup) {
      const foldTurnIds = foldClaimedTurnIds(foldGroup.items);
      const foldSupporting: Artifact[] = [];
      for (const turn of foldTurnIds) {
        const bucket = supportingByTurn.get(turn);
        if (bucket) foldSupporting.push(...bucket);
      }
      // The full product index (incl. working notes) also lives in the fold —
      // the conversation stays a report, the fold is the desk drawer.
      const indexTurn = foldTurnIds.find((turn) => (turnArtifactIndex.get(turn)?.length ?? 0) > 1);
      rows.push({
        key: foldGroup.key,
        node: (
          <AssistantColumnRow showAvatar={claimTurnAvatar()}>
            <TurnFold
              group={foldGroup}
              onOpenSources={handleOpenSources}
              supportingArtifacts={foldSupporting}
              artifactsTotal={indexTurn ? turnArtifactIndex.get(indexTurn)!.length : 0}
              onOpenArtifact={onOpenArtifact}
              onViewAllArtifacts={indexTurn ? () => handleOpenArtifactsIndex(indexTurn) : undefined}
            />
          </AssistantColumnRow>
        ),
      });
      continue;
    }
    if (foldedRowIndices.has(i)) continue;
    // Rows already merged into an earlier group/dedup row render nothing.
    if (consumedSupportingIndices.has(i) || consumedApprovalIndices.has(i)) continue;
    // Collapse a TURN's supporting files into one disclosure row, anchored
    // where its first file appears. Done here rather than in the projection
    // because which files are supporting is server-authoritative truth while
    // collapsing them is display policy — and because the windowing/fold/
    // activity logic above indexes into renderItems, so that array must keep
    // its shape. Grouping is by turn identity, NOT physical adjacency: the
    // timeline interleaves rows that render nothing (workspace notes,
    // live-turn artifacts, suppressed execution items), and adjacency-based
    // runs shattered one turn's files into several "N supporting files"
    // fragments around those invisible rows (operator report 2026-07-19).
    if (isSupportingArtifact(renderItems[i]) && !consumedSupportingIndices.has(i)) {
      const first = renderItems[i] as Extract<ChatRenderItem, { kind: "single" }>;
      const firstTurn = first.item.turnId ?? (first.item.data as Artifact).turnId;
      // The turn's fold houses these files — no chat row at all.
      if (firstTurn != null && foldVisibleTurns.has(firstTurn)) {
        consumedSupportingIndices.add(i);
        for (let j = i + 1; j < renderItems.length; j++) {
          if (!isSupportingArtifact(renderItems[j])) continue;
          const candidate = renderItems[j] as Extract<ChatRenderItem, { kind: "single" }>;
          if ((candidate.item.turnId ?? (candidate.item.data as Artifact).turnId) === firstTurn) {
            consumedSupportingIndices.add(j);
          }
        }
        continue;
      }
      const artifacts: Artifact[] = [first.item.data as Artifact];
      if (firstTurn == null) {
        // Turn-less files cannot be attributed — keep the old adjacency run
        // (contiguous supporting files, fold rows end it).
        for (let j = i + 1; j < renderItems.length; j++) {
          if (turnFoldGroups.has(j)) break;
          if (foldedRowIndices.has(j)) continue;
          if (!isSupportingArtifact(renderItems[j])) break;
          const candidate = renderItems[j] as Extract<ChatRenderItem, { kind: "single" }>;
          if ((candidate.item.turnId ?? (candidate.item.data as Artifact).turnId) != null) break;
          artifacts.push(candidate.item.data as Artifact);
          consumedSupportingIndices.add(j);
        }
      } else {
        for (let j = i + 1; j < renderItems.length; j++) {
          if (foldedRowIndices.has(j)) continue;
          if (!isSupportingArtifact(renderItems[j]) || consumedSupportingIndices.has(j)) continue;
          const candidate = renderItems[j] as Extract<ChatRenderItem, { kind: "single" }>;
          const candidateTurn = candidate.item.turnId ?? (candidate.item.data as Artifact).turnId;
          // Files from OTHER turns start their own group.
          if (candidateTurn !== firstTurn) continue;
          artifacts.push(candidate.item.data as Artifact);
          consumedSupportingIndices.add(j);
        }
      }
      rows.push({
        key: `supporting-${renderRowKey(renderItems[i], i)}`,
        node: (
          <AssistantColumnRow>
            <SupportingFilesGroup artifacts={artifacts} onOpen={onOpenArtifact} />
          </AssistantColumnRow>
        ),
      });
      continue;
    }
    // Identical RESOLVED approvals from one turn collapse to a single line
    // with a ×N count (operator report 2026-07-19: two "已同意 · 访问项目之
    // 外的位置" rows back to back are pure noise). Pending approvals never
    // merge — each is a distinct control the operator must answer.
    if (isResolvedApproval(renderItems[i]) && !consumedApprovalIndices.has(i)) {
      const first = (renderItems[i] as Extract<ChatRenderItem, { kind: "single" }>).item;
      const signature = approvalSignature(first);
      let repeatCount = 1;
      if (signature != null) {
        for (let j = i + 1; j < renderItems.length; j++) {
          if (foldedRowIndices.has(j) || consumedApprovalIndices.has(j)) continue;
          if (!isResolvedApproval(renderItems[j])) continue;
          const candidate = (renderItems[j] as Extract<ChatRenderItem, { kind: "single" }>).item;
          if (approvalSignature(candidate) !== signature) continue;
          repeatCount += 1;
          consumedApprovalIndices.add(j);
        }
      }
      rows.push({
        key: renderRowKey(renderItems[i], i),
        node: (
          <AssistantColumnRow>
            <ApprovalCard
              request={first.data as ApprovalRequest}
              onApprove={onApprove}
              onReject={onReject}
              repeatCount={repeatCount}
            />
          </AssistantColumnRow>
        ),
      });
      continue;
    }
    pushRow(renderItems[i], i);
  }
  if (liveTurnWorkModel) {
    // The consolidated working capsule is the single live surface for ANY
    // turn with execution activity (#635 single status owner). Normally
    // anchored at the turn's first work row above; fall back to the tail
    // when the loop never found an anchor (e.g. every turn row suppressed).
    pushLiveCapsule();
  } else {
    const indicator = renderActivityIndicator();
    if (indicator) rows.push({ key: "activity-indicator", node: indicator });
  }

  return (
    <div className="relative min-h-0 flex-1">
      {/* One deduplicated, coarse live-activity announcement for assistive tech. */}
      <div data-testid="chat-live-status" role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {liveAnnouncement}
      </div>
      {/* overflow-anchor off: the browser's native scroll anchoring and our
          deterministic scrollHeight-delta correction would BOTH compensate for
          prepended history rows (double-correcting into a wrong position).
          Exactly one owner: ours — it also covers scrollTop 0, where native
          anchoring is suppressed. */}
      <div
        ref={scrollRegionRef}
        data-testid="chat-scroll-region"
        className="h-full overflow-y-auto [overflow-anchor:none]"
        onScroll={handleScroll}
      >
        <div
          data-testid="chat-timeline-rail"
          role="feed"
          tabIndex={0}
          aria-busy={sessionState !== "IDLE"}
          aria-label={t("chat.timeline.ariaLabel")}
          onKeyDown={handleFeedKeyDown}
          className="mx-auto flex w-full max-w-[960px] flex-col gap-3 px-4 py-6 lg:py-8"
        >
          {loadingOlderHistory && (
            <div
              data-testid="chat-loading-older"
              className="mx-auto flex items-center gap-2 py-1 text-[12px] text-ink/40"
            >
              <Loader2 size={12} className="animate-spin" />
              {t("chat.history.loadingOlder")}
            </div>
          )}
          {hiddenEarlierCount > 0 && (
            <button
              type="button"
              data-testid="chat-show-earlier"
              onClick={() => setShowEarlier(true)}
              className="mx-auto mb-1 inline-flex h-8 items-center rounded-full border border-ink/[0.12] px-3 text-[12px] text-ink/55 transition-colors hover:border-ink/[0.2] hover:text-ink/85"
            >
              {translateMessage(locale, "chat.timeline.showEarlier", { count: String(hiddenEarlierCount) })}
            </button>
          )}
          {rows.map(({ key, node }, mountedIndex) => (
            <div
              key={key}
              data-chat-row
              role="article"
              aria-posinset={hiddenEarlierCount + mountedIndex + 1}
              aria-setsize={renderItems.length + (activityIndicator !== "none" ? 1 : 0)}
              tabIndex={0}
              className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus/40"
            >
              {node}
            </div>
          ))}
        </div>
      </div>
      {!autoFollow && (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
          <button
            type="button"
            data-testid="chat-jump-to-latest"
            onClick={() => scrollToLatest()}
            className="pointer-events-auto inline-flex h-8 items-center gap-2 rounded-full border border-ink/[0.12] bg-base/95 px-3 text-[12px] text-ink/65 shadow-lg backdrop-blur transition-colors hover:border-ink/[0.2] hover:text-ink/90"
          >
            {sessionState !== "IDLE" && <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-activity" />}
            <span>{sessionState !== "IDLE" ? t("chat.follow.responding") : t("chat.follow.latest")}</span>
            <ArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
