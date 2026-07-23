import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleSlash,
  ExternalLink,
  FileSearch,
  FileText,
  Globe,
  Loader2,
  PenLine,
  Search,
  Sparkles,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskUpdate, ToolEvent } from "@/types";
import {
  buildToolStepSummary,
  compactIssueDetail,
  isCancelledTask,
  isTurnLifecycleTask,
  sanitizeTaskTitle,
  toolRunningActionLabel,
  toolUserActionLabel,
  type ExecutionBlockModel,
  type ExecutionSourceRef,
  type ToolStepKind,
} from "./execution";
import { buildTaskTree, type TaskGroupNode, type TaskNodeState, type TaskTreeNode } from "./task-tree";
import { formatDurationForLocale, translateMessage, useLocale, type Locale } from "@/i18n";
import { formatApproximateDurationForLocale } from "@/i18n/format";

/** Open the workbench source panel for an aggregated activity row. */
export type OpenSourcesHandler = (sources: ExecutionSourceRef[], label: string) => void;

interface ExecutionBlockProps {
  block: ExecutionBlockModel;
  /** Open the aggregated source list in the right workbench panel. */
  onOpenSources?: OpenSourcesHandler;
  /** The parent (turn fold) renders one combined Technical details for the
   *  whole turn — suppress this block's own copy. */
  suppressTechnicalDetails?: boolean;
  /**
   * The runtime no longer knows this block's turn — it died mid-flight
   * (process restart, killed turn). Running visuals must freeze into an
   * explicit interrupted state instead of spinning forever.
   */
  interrupted?: boolean;
  /**
   * Render inside an already-expanded turn fold: no own "View work" summary
   * button (a disclosure inside a disclosure is redundant) — just the phase
   * timeline plus the Technical details expander.
   */
  embedded?: boolean;
}

const EXECUTION_TIMELINE_SCROLL_THRESHOLD = 8;

type RowState = "done" | "running" | "blocked" | "skipped" | "pending" | "interrupted" | "queued" | "cancelled";

interface TimelineRow {
  key: string;
  label: string;
  detail?: string;
  /**
   * Persisted result excerpt of a completed plan step / task group. Unlike
   * `detail` (always visible under the label), this renders only while the
   * row's own disclosure is open — a step that ran without tools still has
   * something to show behind its chevron.
   */
  resultDetail?: string;
  state: RowState;
  /** Nesting depth for the nested task-timeline (Issue #624); 0 = top level. */
  depth?: number;
  /** True for a task-group header row so it reads as a group, not a leaf step. */
  isGroup?: boolean;
  /**
   * Frame-stable identity for group rows. `key` for a task row embeds the
   * per-event id, which `genId()` regenerates on every task_update/progress
   * frame — per-phase disclosure state keyed on it would snap shut on each
   * heartbeat. Group rows carry the stable task_id here instead.
   */
  stableKey?: string;
  timestamp: number;
  durationMs?: number;
  url?: string | null;
  hostname?: string | null;
  showHostnameChip?: boolean;
  isSkillActivation?: boolean;
  skillSuffixName?: string | null;
  skillDescription?: string | null;
  skillLoadOutcome?: "success" | "not_found" | "ineligible" | null;
  skillMissingBins?: string[];
  skillMissingEnv?: string[];
  skillLoadError?: string | null;
  /** Step kind of the underlying tool row — drives narrative aggregation. */
  kind?: ToolStepKind;
  /** Web sources this tool row consulted. */
  sources?: ExecutionSourceRef[];
  /** Number of adjacent identical steps this row stands for (≥2 renders a
   *  quiet ×N suffix instead of N indistinguishable rows). */
  repeatCount?: number;
  /** Set when this row aggregates a run of adjacent same-kind steps. All
   *  labels are pre-localized at build time with the block's transcript
   *  locale, so the row component never consults the UI locale. */
  activityGroup?: {
    kind: "search" | "read";
    stepCount: number;
    sources: ExecutionSourceRef[];
    sourceListLabel: string;
    openAllLabel: string;
  };
}

function taskUserStatusLabel(
  status: TaskUpdate["userStatus"] | undefined,
  locale: Locale,
  taskStatus?: TaskUpdate["status"],
): string | null {
  switch (status) {
    case "received":
      return translateMessage(locale, "execution.taskStatus.received");
    case "planning":
      return translateMessage(
        locale,
        taskStatus === "completed" ? "execution.taskStatus.planningDone" : "execution.taskStatus.planning",
      );
    case "responding":
      return translateMessage(
        locale,
        taskStatus === "completed" ? "execution.taskStatus.respondingDone" : "execution.taskStatus.responding",
      );
    case "checking":
      return translateMessage(locale, "execution.taskStatus.checking");
    case "starting":
      return translateMessage(locale, "execution.taskStatus.starting");
    case "working":
      return translateMessage(
        locale,
        taskStatus === "completed" ? "execution.taskStatus.workingDone" : "execution.taskStatus.working",
      );
    case "verifying":
      return translateMessage(locale, "execution.taskStatus.verifying");
    case "done":
      return translateMessage(locale, "execution.taskStatus.done");
    case "blocked":
      return translateMessage(locale, "execution.taskStatus.blocked");
    default:
      return null;
  }
}

function isTurnLifecycleStatus(status: TaskUpdate["userStatus"] | undefined): boolean {
  return status === "received" || status === "planning" || status === "working" || status === "responding";
}

function localizedIssueDetail(detail: string, locale: Locale): string {
  if (detail === "Source temporarily unavailable") {
    return translateMessage(locale, "execution.issue.sourceTemporarilyUnavailable");
  }
  if (detail === "Source could not be read") {
    return translateMessage(locale, "execution.issue.sourceUnreadable");
  }
  if (detail === "Search returned no useful results") {
    return translateMessage(locale, "execution.issue.searchNoResults");
  }
  if (detail === "Search service temporarily unavailable") {
    return translateMessage(locale, "execution.issue.searchUnavailable");
  }
  if (detail === "File not found") {
    return translateMessage(locale, "execution.issue.fileNotFound");
  }
  if (detail === "Command reported errors") {
    return translateMessage(locale, "execution.issue.commandErrors");
  }
  const missingEnv = detail.match(/^Missing\s+([A-Z][A-Z0-9_]+)$/);
  if (locale === "zh-CN" && missingEnv) return `缺少 ${missingEnv[1]}`;
  return detail;
}

function shouldShowLifecycleTasks(block: ExecutionBlockModel): boolean {
  const lifecycleTasks = block.tasks.filter(isTurnLifecycleTask);
  if (lifecycleTasks.length === 0) return false;

  const nonLifecycleTaskCount = block.tasks.length - lifecycleTasks.length;
  if (block.status === "running") return true;
  if (nonLifecycleTaskCount > 0) return true;
  if (block.toolCount >= 3) return true;
  if (block.totalElapsedMs >= 8_000) return true;
  return block.status === "mixed" && block.toolCount > 1;
}

/**
 * The internal semantic quality check ("结果质量校验") is machinery, not a
 * user-facing step — its outcome already lands in the run's terminal status and
 * the final message. It never gets a timeline row, for new OR historical runs
 * (operators repeatedly rejected it as noise). Filter any persisted verification
 * row out here so it renders nowhere.
 */
function isPlanVerificationRow(task: TaskUpdate): boolean {
  return task.rawStatus === "plan_verification_failed" || task.rawStatus === "plan_verification_unverified";
}

function visibleTasksForBlock(block: ExecutionBlockModel): TaskUpdate[] {
  const includeLifecycle = shouldShowLifecycleTasks(block);
  const base = block.tasks.filter((task) => !isPlanVerificationRow(task));
  const tasks = includeLifecycle ? base : base.filter((task) => !isTurnLifecycleTask(task));
  if (block.status === "running") return tasks;
  return tasks.filter((task) => !(task.userStatus === "working" && task.status === "completed" && isTurnLifecycleTask(task)));
}

function getDisplayTools(tools: ToolEvent[]): ToolEvent[] {
  const byCallId = new Map<string, ToolEvent>();

  tools.forEach((tool, index) => {
    const key = tool.callId || `${tool.id}-${index}`;
    const existing = byCallId.get(key);
    if (!existing || tool.phase === "end" || tool.timestamp > existing.timestamp) {
      byCallId.set(key, tool);
    }
  });

  return [...byCallId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function taskState(task: TaskUpdate): RowState {
  if (task.status === "failed") return "blocked";
  if (task.status === "running") return "running";
  if (task.status === "pending") return "pending";
  return "done";
}

function buildTaskRow(task: TaskUpdate, locale: Locale): TimelineRow {
  const title = sanitizeTaskTitle(task.title);
  const statusLabel = taskUserStatusLabel(task.userStatus, locale, task.status);
  const label = isTurnLifecycleTask(task)
    ? statusLabel || title || translateMessage(locale, "execution.taskFallback")
    : title || statusLabel || translateMessage(locale, "execution.taskFallback");
  // Raw failure details of failed tasks stay in Technical details only
  // (noise-reduction decision, Issue #624 tests).
  const detail =
    task.status !== "failed" && !isTurnLifecycleStatus(task.userStatus) && statusLabel && statusLabel !== label
      ? statusLabel
      : undefined;

  return {
    key: `task:${task.id}`,
    label,
    detail,
    state: taskState(task),
    timestamp: task.timestamp,
    durationMs: task.elapsed_ms,
  };
}

function getTaskRows(tasks: TaskUpdate[], locale: Locale): TimelineRow[] {
  return tasks.map((task) => buildTaskRow(task, locale));
}

function getToolState(tool: ToolEvent, block: ExecutionBlockModel): RowState {
  if (tool.phase === "start") return "running";
  if (tool.status !== "error") return "done";
  return block.status === "mixed" ? "skipped" : "blocked";
}

function issueRepeatSuffix(count: number, locale: Locale): string {
  if (count <= 1) return "";
  const phrase = translateMessage(locale, "execution.repeated", { count });
  return locale === "zh-CN" ? `（${phrase}）` : ` (${phrase})`;
}

function skillActivationDetail(row: TimelineRow, locale: Locale): string {
  if (row.state === "running") return translateMessage(locale, "execution.skill.loading");

  if (row.state === "done" && (row.skillLoadOutcome === "success" || !row.skillLoadOutcome)) {
    return translateMessage(locale, "execution.skill.loaded");
  }

  if (row.skillLoadOutcome === "not_found") {
    return translateMessage(locale, "execution.skill.notFound");
  }

  if (row.skillLoadOutcome === "ineligible") {
    return translateMessage(locale, "execution.skill.ineligible");
  }

  return row.detail || row.skillLoadError || translateMessage(locale, "execution.skill.failed");
}

function buildToolRow(tool: ToolEvent, block: ExecutionBlockModel, locale: Locale): TimelineRow {
    const summary = buildToolStepSummary(tool, locale);
    const state = getToolState(tool, block);
    const compactToolIssue = compactIssueDetail(tool.error || tool.result || "");
    const issue = state === "blocked" || state === "skipped"
      ? block.issueSummaries.find(
          (item) => item.label === toolUserActionLabel(tool.tool) && item.detail.toLowerCase() === compactToolIssue.toLowerCase(),
        ) ?? block.issueSummaries.find((item) => item.label === toolUserActionLabel(tool.tool)) ?? block.issueSummaries[0]
      : undefined;
    const issueDetail = issue
      ? `${localizedIssueDetail(issue.detail, locale)}${issueRepeatSuffix(issue.count, locale)}`
      : undefined;

    if (summary.isSkillActivation) {
      const compactError = localizedIssueDetail(compactIssueDetail(tool.error || tool.result || ""), locale);
      const fallbackError = compactError || undefined;
      const row: TimelineRow = {
        key: `tool:${tool.id}`,
        label: toolRunningActionLabel(tool.tool, locale, summary.skillName),
        detail: state === "blocked" || state === "skipped" ? (issueDetail ?? fallbackError) : undefined,
        state,
        timestamp: tool.timestamp,
        durationMs: tool.elapsed_ms,
        url: null,
        hostname: null,
        showHostnameChip: false,
        isSkillActivation: true,
        skillSuffixName: null,
        skillDescription: summary.skillDescription,
        skillLoadOutcome: summary.skillLoadOutcome,
        skillMissingBins: summary.skillMissingBins,
        skillMissingEnv: summary.skillMissingEnv,
        skillLoadError: summary.skillLoadError ?? fallbackError,
      };
      return {
        ...row,
        detail: skillActivationDetail(row, locale),
      };
    }

    const userFacingLabel = summary.kind === "shell"
      ? translateMessage(locale, "execution.step.runFallback")
      : summary.kind === "write"
        ? translateMessage(locale, "execution.step.writeFallback")
        : summary.kind === "inspect"
          ? translateMessage(locale, "execution.step.inspectFallback")
          : summary.timelineLabel;
    const label = state === "skipped"
      ? issueDetail ?? translateMessage(locale, "execution.tool.skippedSource")
      : state === "blocked"
        ? translateMessage(locale, "execution.tool.blocked", { label: toolUserActionLabel(tool.tool, locale) })
        : userFacingLabel;
    const detail = state === "blocked"
      ? issueDetail ?? localizedIssueDetail(compactIssueDetail(tool.error || tool.result || ""), locale)
      : undefined;

    return {
      key: `tool:${tool.id}`,
      label,
      detail,
      state,
      timestamp: tool.timestamp,
      durationMs: tool.elapsed_ms,
      url: state === "blocked" || summary.isSkillActivation ? null : summary.url,
      hostname: state === "blocked" || summary.isSkillActivation ? null : summary.hostname,
      showHostnameChip: state === "blocked" || summary.isSkillActivation ? false : summary.showHostnameChip,
      isSkillActivation: summary.isSkillActivation,
      skillSuffixName: null,
      kind: summary.kind,
      sources: summary.sources,
    };
}

/**
 * Narrative aggregation (four-region model, region 4): a run of adjacent
 * successful same-kind web steps at the same depth collapses into one
 * activity row — "Searched 14 sources" instead of 14 raw queries. The
 * individual queries stay reachable in Technical details; the aggregated
 * sources open on demand. Rows that carry a visible detail (issues, skipped
 * sources, skill activations) never fold, so nothing truthful is hidden.
 */
const GROUPABLE_KINDS = new Set<ToolStepKind>(["search", "read"]);

function isGroupableRow(row: TimelineRow): boolean {
  return Boolean(
    row.kind
      && GROUPABLE_KINDS.has(row.kind)
      // Only steps that actually consulted web sources fold — a local
      // read_file or a sourceless memory search must keep its own truthful
      // row ("Read config.ts"), never a false "Browsed N pages".
      && row.sources
      && row.sources.length > 0
      && !row.isGroup
      && !row.isSkillActivation
      && !row.detail
      && (row.state === "done" || row.state === "running"),
  );
}

function dedupeSources(rows: TimelineRow[]): ExecutionSourceRef[] {
  const seen = new Set<string>();
  const merged: ExecutionSourceRef[] = [];
  for (const row of rows) {
    for (const source of row.sources ?? []) {
      if (seen.has(source.url)) continue;
      seen.add(source.url);
      merged.push(source);
    }
  }
  return merged;
}

function buildActivityGroupRow(run: TimelineRow[], locale: Locale): TimelineRow {
  const first = run[0];
  const kind = first.kind as "search" | "read";
  const sources = dedupeSources(run);
  const running = run.some((row) => row.state === "running");
  // Every grouped row carries web sources (isGroupableRow gate), so the
  // count is always the deduped source count — never a step count.
  const label = kind === "read"
    ? (sources.length === 1
        ? translateMessage(locale, "execution.group.browsedPagesOne")
        : translateMessage(locale, "execution.group.browsedPages", { count: sources.length }))
    : sources.length === 1
      ? translateMessage(locale, "execution.group.searchedSourcesOne")
      : translateMessage(locale, "execution.group.searchedSources", { count: sources.length });
  return {
    key: `group:${first.key}`,
    label,
    state: running ? "running" : "done",
    depth: first.depth,
    timestamp: first.timestamp,
    kind,
    activityGroup: {
      kind,
      stepCount: run.length,
      sources,
      sourceListLabel: translateMessage(locale, "execution.group.sourceListLabel"),
      openAllLabel: translateMessage(locale, "execution.group.openInWorkbench", { count: sources.length }),
    },
  };
}

/**
 * Adjacent leaf rows with the same label and outcome carry zero extra
 * information per row — collapse them into one row with a quiet ×N suffix.
 * Successful rows only merge when neither has detail. Issue rows merge only
 * when their details are exactly equal; every raw event remains available in
 * Technical details, so the compact timeline loses no diagnostic evidence.
 */
function collapseRepeatedRows(rows: TimelineRow[]): TimelineRow[] {
  const out: TimelineRow[] = [];
  const issueRowIndex = new Map<string, number>();
  for (const row of rows) {
    // A group boundary is a real task/plan phase boundary. Identical failures
    // may merge across intervening leaf activity inside one phase, but never
    // across two phases whose separate outcomes the operator must be able to
    // distinguish.
    if (row.isGroup) issueRowIndex.clear();
    const isIssueLeaf = Boolean(
      !row.isGroup
      && !row.activityGroup
      && !row.isSkillActivation
      && (row.state === "blocked" || row.state === "skipped" || row.state === "interrupted"),
    );
    if (isIssueLeaf) {
      const signature = `${row.depth ?? 0}:${row.state}:${row.label}:${row.detail ?? ""}`;
      const existingIndex = issueRowIndex.get(signature);
      if (existingIndex != null) {
        const existing = out[existingIndex];
        out[existingIndex] = { ...existing, repeatCount: (existing.repeatCount ?? 1) + 1 };
        continue;
      }
      issueRowIndex.set(signature, out.length);
    }
    const prev = out.at(-1);
    const sameLeaf = Boolean(
      prev
      && !prev.isGroup && !row.isGroup
      && !prev.activityGroup && !row.activityGroup
      && !prev.isSkillActivation && !row.isSkillActivation
      && (prev.depth ?? 0) === (row.depth ?? 0)
      && prev.label === row.label
      && !prev.showHostnameChip && !row.showHostnameChip,
    );
    const repeatedSuccess = sameLeaf
      && !prev?.detail && !row.detail
      && prev?.state === "done" && row.state === "done";
    const repeatedIssue = sameLeaf
      && Boolean(prev?.detail) && prev?.detail === row.detail
      && prev?.state === row.state
      && (row.state === "blocked" || row.state === "skipped" || row.state === "interrupted");
    if (
      prev
      && (repeatedSuccess || repeatedIssue)
    ) {
      out[out.length - 1] = { ...prev, repeatCount: (prev.repeatCount ?? 1) + 1 };
      continue;
    }
    out.push(row);
  }
  return out;
}

export function aggregateActivityRows(rows: TimelineRow[], locale: Locale): TimelineRow[] {
  const out: TimelineRow[] = [];
  let run: TimelineRow[] = [];

  const flush = () => {
    if (run.length >= 2) {
      out.push(buildActivityGroupRow(run, locale));
    } else {
      out.push(...run);
    }
    run = [];
  };

  for (const row of rows) {
    if (isGroupableRow(row)) {
      const sameRun = run.length === 0
        || (run[0].kind === row.kind && (run[0].depth ?? 0) === (row.depth ?? 0));
      if (!sameRun) flush();
      run.push(row);
      continue;
    }
    flush();
    out.push(row);
  }
  flush();
  return out;
}

function getToolRows(tools: ToolEvent[], block: ExecutionBlockModel, locale: Locale): TimelineRow[] {
  return getDisplayTools(tools).map((tool) => buildToolRow(tool, block, locale));
}

function applyInterrupted(row: TimelineRow, interrupted: boolean): TimelineRow {
  return interrupted && row.state === "running" ? { ...row, state: "interrupted" } : row;
}

/**
 * Flatten the nested task tree (Issue #624) into depth-tagged rows, preserving
 * chronology within every relationship. A task-group header row is followed by
 * its children (subtasks + tools) indented one level deeper. Concurrent subtasks
 * stay distinct because each keeps its own `task_id` node — they are never merged.
 */
function flattenTaskTree(
  nodes: TaskTreeNode[],
  block: ExecutionBlockModel,
  locale: Locale,
  interrupted: boolean,
  depth: number,
  out: TimelineRow[],
): void {
  for (const node of nodes) {
    if (node.kind === "tool") {
      out.push(applyInterrupted({ ...buildToolRow(node.tool, block, locale), depth }, interrupted));
      continue;
    }
    out.push(buildTaskGroupRow(node, locale, interrupted, depth));
    flattenTaskTree(node.children, block, locale, interrupted, depth + 1, out);
  }
}

function buildTaskGroupRow(node: TaskGroupNode, locale: Locale, interrupted: boolean, depth: number): TimelineRow {
  const base = buildTaskRow(node.task, locale);
  const state = nodeStateToRowState(node.state, interrupted);
  // Surface the truthful lifecycle state as a chip on cancelled/queued nodes,
  // whose glyph alone is easy to miss; running/done/failed read from the glyph.
  const stateChip =
    node.state === "cancelled"
      ? translateMessage(locale, "execution.node.cancelled")
      : node.state === "queued"
        ? translateMessage(locale, "execution.node.queued")
        : null;
  // For a cancelled/queued node prefer a real reason from the task, else the
  // localized chip — never the raw lifecycle string (e.g. "task_cancelled"),
  // which `buildTaskRow` would otherwise surface as the failed-task detail.
  return {
    ...base,
    state,
    depth,
    isGroup: true,
    stableKey: `group-task:${node.task.task_id}`,
    detail: stateChip ?? base.detail,
    resultDetail: node.task.status === "completed" ? node.task.detail : undefined,
  };
}

function getTimelineRows(block: ExecutionBlockModel, locale: Locale, interrupted: boolean): TimelineRow[] {
  const tree = buildTaskTree(visibleTasksForBlock(block), block.tools);
  if (tree.hasHierarchy) {
    const rows: TimelineRow[] = [];
    flattenTaskTree(tree.roots, block, locale, interrupted, 0, rows);
    return collapseRepeatedRows(aggregateActivityRows(rows, locale));
  }
  const taskRows = getTaskRows(visibleTasksForBlock(block), locale);
  const toolRows = getToolRows(block.tools, block, locale);
  const merged = [...taskRows, ...toolRows]
    .map((row) => applyInterrupted(row, interrupted))
    .sort((a, b) => a.timestamp - b.timestamp);
  return collapseRepeatedRows(planSpineRows(aggregateActivityRows(merged, locale), block, locale));
}

/**
 * Plan-as-spine (four-region model, region 3): when the turn carries a typed
 * plan (#735), its phases become the parent rows and tool/activity rows nest
 * under the phase whose taskId they ran for. Rows with no owning phase stay
 * at the root, after the plan — chronology inside every phase is preserved.
 * Without a plan (or when the task tree already built a hierarchy) rows pass
 * through unchanged.
 */
function planSpineRows(rows: TimelineRow[], block: ExecutionBlockModel, locale: Locale): TimelineRow[] {
  const plan = block.plan;
  if (!plan || plan.phases.length === 0) return rows;

  const phaseIds = new Map<string, number>();
  plan.phases.forEach((phase, index) => phaseIds.set(phase.taskId, index));

  const taskByTaskId = new Map(block.tasks.map((task) => [task.task_id, task]));
  const toolPhase = new Map<string, number>();
  for (const tool of block.tools) {
    if (tool.taskId != null && phaseIds.has(tool.taskId)) {
      toolPhase.set(`tool:${tool.id}`, phaseIds.get(tool.taskId)!);
    }
  }
  // The phase header replaces the phase's own task_update row — keeping both
  // would print every phase title twice.
  const phaseTaskRowKeys = new Set(
    block.tasks.filter((task) => phaseIds.has(task.task_id)).map((task) => `task:${task.id}`),
  );

  const byPhase = new Map<number, TimelineRow[]>();
  const rest: TimelineRow[] = [];
  for (const row of rows) {
    if (phaseTaskRowKeys.has(row.key)) continue;
    // Group rows aggregate several tools; attribute by their first tool key.
    const key = row.key.startsWith("group:") ? row.key.slice("group:".length) : row.key;
    const phaseIndex = toolPhase.get(key);
    if (phaseIndex == null) {
      rest.push(row);
      continue;
    }
    const bucket = byPhase.get(phaseIndex) ?? [];
    bucket.push({ ...row, depth: (row.depth ?? 0) + 1 });
    byPhase.set(phaseIndex, bucket);
  }
  // A plan with no attributable rows AND no per-step results would add a
  // skeleton with nothing behind any row. A tool-less plan whose steps carry
  // persisted result excerpts still earns the spine — each phase discloses
  // what it produced.
  const hasStepResults = plan.phases.some(
    (phase) => taskByTaskId.get(phase.taskId)?.status === "completed" && taskByTaskId.get(phase.taskId)?.detail,
  );
  if (byPhase.size === 0 && !hasStepResults) return rows;

  const out: TimelineRow[] = [];
  plan.phases.forEach((phase, index) => {
    const task = taskByTaskId.get(phase.taskId);
    const children = byPhase.get(index) ?? [];
    const state: RowState = task?.status === "failed"
      ? "blocked"
      : task?.status === "completed"
        ? "done"
        : task?.status === "running" || children.some((row) => row.state === "running")
          ? "running"
          : children.length > 0
            ? "done"
            : "pending";
    out.push({
      key: `plan-phase:${phase.taskId}`,
      label: sanitizeTaskTitle(phase.title) || phase.title,
      state,
      depth: 0,
      isGroup: true,
      timestamp: children[0]?.timestamp ?? 0,
      resultDetail: task?.status === "completed" ? task.detail : undefined,
    });
    out.push(...children);
  });
  return [...out, ...rest];
}

function compactSummary(block: ExecutionBlockModel, interrupted: boolean, locale: Locale): string {
  if (interrupted) return translateMessage(locale, "execution.summary.interrupted");
  const concreteTasks = block.tasks.filter((task) => !isTurnLifecycleTask(task));
  // A turn the envelope marked cancelled reads as cancelled even if its individual
  // tool/task rows never carried a cancel status (the abort landed between steps).
  if (block.status === "cancelled" || (concreteTasks.length > 0 && concreteTasks.every(isCancelledTask) && block.tools.length === 0)) {
    return translateMessage(locale, "execution.summary.cancelledCompact");
  }
  return translateMessage(locale, "execution.summary.viewWork");
}

/**
 * Dedicated state/type iconography (mockup parity — no text "✓" glyphs):
 * group rows (plan phases, task groups) carry a state ring; leaf activity
 * rows carry their kind's icon, tinted by state.
 */
function stateTintClass(state: RowState): string {
  // Done is the expected state — it stays in muted ink like the prose around
  // it. Color is reserved for rows that need the operator's eye: running
  // (activity), blocked/interrupted (warning). See docs/DESIGN.md.
  if (state === "done") return "text-ink/35";
  if (state === "blocked" || state === "interrupted") return "text-warning";
  if (state === "skipped" || state === "cancelled") return "text-warning/80";
  if (state === "running") return "text-activity";
  return "text-ink/24";
}

/** Plan progress for the card header: completed phases / total phases. */
function planProgress(block: ExecutionBlockModel): { done: number; total: number } | null {
  const plan = block.plan;
  if (!plan || plan.phases.length === 0) return null;
  const phaseIds = new Set(plan.phases.map((phase) => phase.taskId));
  const done = block.tasks.filter((task) => phaseIds.has(task.task_id) && task.status === "completed").length;
  return { done, total: plan.phases.length };
}

/**
 * Card-level "Verifying" state (presentation matrix): while a verification
 * step runs, the card must not read as done — the header names the phase.
 */
function planVerifying(block: ExecutionBlockModel): boolean {
  return block.tasks.some((task) => task.status === "running" && task.userStatus === "verifying");
}

/**
 * The plan card (operator decisions 2026-07-19): frameless AND headerless —
 * no border, no background shift, no progress bar, and no in-card title/
 * fraction row. A terminal plan is a to-do list the assistant has crossed
 * off: the row text carries the state (struck-through done, quiet pending),
 * and the surrounding turn fold already labels the section. Keeping a
 * title + fraction + bar made it a mini-dashboard embedded in prose.
 * The "Verifying" chip is the one exception — while a verification step
 * runs the card must not read as settled. (docs/DESIGN.md "Execution
 * Process Display".)
 */
function PlanCardShell({ locale, verifying = false, children }: { locale: Locale; verifying?: boolean; children: ReactNode }) {
  return (
    <div
      data-testid="execution-plan-card"
      className="px-3.5 pb-2.5 pt-2"
    >
      {verifying && (
        <div data-testid="execution-plan-verifying" className="mb-1.5 text-[12px] text-activity/70">
          {translateMessage(locale, "execution.plan.verifying")}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * Per-phase disclosure for a plan's timeline (operator decision 2026-07-18):
 * the phase spine (group rows) is the default view; each phase row is itself
 * the toggle for ITS OWN tool rows — clicking one phase expands only that
 * phase, never the whole timeline. A plan-less working turn has no spine —
 * its rows ARE the process, and the capsule expansion is already the
 * disclosure, so they render directly. Applies live and terminal alike.
 */
function PlanTimelineBody({ rows, onOpenSources }: { rows: TimelineRow[]; onOpenSources?: OpenSourcesHandler }) {
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const hasGroupRows = rows.some((row) => row.isGroup);
  // Attribute every row to the nearest preceding group row at a shallower
  // depth (the flat list is a pre-order walk, so a depth-keyed stack of open
  // groups recovers the tree). Rows with no owning group are always visible.
  // Disclosure identity must survive live streaming: task rows regenerate
  // their event id (and thus row.key) on every progress/heartbeat frame, so
  // groups toggle and reconcile by their frame-stable key instead.
  const groupKey = (row: TimelineRow) => row.stableKey ?? row.key;
  const items: Array<{ row: TimelineRow; ancestors: string[] }> = [];
  const childCounts = new Map<string, number>();
  const stack: Array<{ key: string; depth: number }> = [];
  for (const row of rows) {
    const depth = row.depth ?? 0;
    while (stack.length > 0 && depth <= stack[stack.length - 1].depth) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) childCounts.set(parent.key, (childCounts.get(parent.key) ?? 0) + 1);
    items.push({ row, ancestors: stack.map((entry) => entry.key) });
    if (row.isGroup) stack.push({ key: groupKey(row), depth });
  }
  const toggleGroup = (key: string) =>
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const visible = hasGroupRows
    ? items.filter(({ ancestors }) => ancestors.every((key) => expandedGroups.has(key)))
    : items;
  return (
    // Body-size phase rows need list breathing room (2.5), not the compact
    // console rhythm (1.5) — the paragraph-gap-beats-line-gap rule applies
    // to this list too.
    <div className="space-y-2.5">
      {visible.map(({ row }) => (
        <TimelineRowView
          key={groupKey(row)}
          row={row}
          onOpenSources={onOpenSources}
          disclosure={
            // A group discloses when it owns child rows OR carries a persisted
            // step result — a tool-less completed step must still be openable
            // (operator report 2026-07-19: dead rows read as broken).
            row.isGroup && ((childCounts.get(groupKey(row)) ?? 0) > 0 || row.resultDetail)
              ? { expanded: expandedGroups.has(groupKey(row)), onToggle: () => toggleGroup(groupKey(row)) }
              : undefined
          }
        />
      ))}
    </div>
  );
}

/**
 * Live plan capsule (operator decision 2026-07-18, mockup parity with the
 * compact "Working…" card): while the plan runs, the chat shows ONE quiet
 * rounded capsule — title, current action, and (for plan turns) progress
 * fraction + thin bar. Click expands the process; plan turns get the phase
 * spine with tool rows one more disclosure deeper (PlanTimelineBody).
 * Keyed to the turn by the caller, so narration never remounts it
 * (anti-flicker invariant).
 */
function LiveWorkCapsule({ block, locale, rows, onOpenSources }: { block: ExecutionBlockModel; locale: Locale; rows: TimelineRow[]; onOpenSources?: OpenSourcesHandler }) {
  const [open, setOpen] = useState(false);
  // With a typed plan the capsule carries phases and a progress bar; without
  // one it is the SAME working capsule (four-region model: every working
  // turn's process lives here, plans are not special) minus plan chrome.
  const progress = planProgress(block);
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  const verifying = planVerifying(block);
  const title = translateMessage(locale, progress ? "execution.plan.title" : "execution.capsule.working");
  return (
    <div data-testid={progress ? "execution-live-plan" : "execution-live-work"} className="w-full max-w-[640px]">
      {/* The capsule is a button — it keeps a faint surface lift for click
          affordance, but no hairline frame (operator decision 2026-07-19). */}
      <div
        data-testid="execution-plan-card"
        className="overflow-hidden rounded-lg bg-ink/[0.02]"
      >
        <button
          type="button"
          data-testid="plan-capsule-toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full flex-col gap-0.5 px-3.5 pb-2 pt-2 text-left transition-colors duration-180ms hover:bg-ink/[0.015]"
        >
          <span className="flex w-full items-center gap-2">
            <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-activity" strokeWidth={2} />
            <span className="text-[12px] font-medium text-ink/70">{title}</span>
            {verifying && (
              <span data-testid="execution-plan-verifying" className="text-[11px] text-activity/70">
                {translateMessage(locale, "execution.plan.verifying")}
              </span>
            )}
            {progress && (
              <span className="ml-auto text-[11.5px] tabular-nums text-ink/32">
                {progress.done} / {progress.total}
              </span>
            )}
            <ChevronDown size={12} className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", !progress && "ml-auto", open && "rotate-180")} />
          </span>
          <span className="live-verb-shimmer w-full truncate pl-[22px] text-[12px] text-ink/45">{liveLabel(block, locale)}</span>
          {pct != null && (
            <span className="mt-1 block h-0.5 w-full overflow-hidden rounded-full bg-ink/[0.06]">
              {/* Always activity: this capsule only exists while the plan is
                  live, and the terminal card carries no bar at all. */}
              <span className="block h-full rounded-full bg-activity/60 transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </span>
          )}
        </button>
        {open && (
          <div className="px-3.5 pb-2 pt-0.5 duration-180ms motion-safe:animate-in motion-safe:fade-in-0">
            <PlanTimelineBody rows={rows} onOpenSources={onOpenSources} />
          </div>
        )}
      </div>
    </div>
  );
}

function GroupStateIcon({ state }: { state: RowState }) {
  const className = cn("h-[15px] w-[15px] shrink-0", stateTintClass(state));
  if (state === "done") return <Check className={className} strokeWidth={2} aria-hidden="true" />;
  if (state === "running") return <Loader2 className={cn(className, "animate-spin")} strokeWidth={2.2} aria-hidden="true" />;
  if (state === "blocked" || state === "interrupted") return <AlertTriangle data-testid="execution-warning-icon" className={className} strokeWidth={2} aria-hidden="true" />;
  if (state === "skipped" || state === "cancelled") return <CircleSlash className={className} strokeWidth={2} aria-hidden="true" />;
  return <Circle className={cn(className, "opacity-70")} strokeWidth={2} aria-hidden="true" />;
}

const LEAF_KIND_ICONS: Record<ToolStepKind, typeof Search> = {
  search: Search,
  read: Globe,
  shell: Terminal,
  write: PenLine,
  inspect: FileSearch,
  skill: Sparkles,
  generic: FileText,
};

function LeafKindIcon({ row }: { row: TimelineRow }) {
  const Icon = row.kind ? LEAF_KIND_ICONS[row.kind] : FileText;
  const stateClass = row.state === "running"
    ? "text-activity"
    : row.state === "blocked" || row.state === "interrupted"
      ? "text-warning"
      : row.state === "skipped" || row.state === "cancelled"
        ? "text-warning/75"
        : "text-ink/30";
  return <Icon className={cn("h-3.5 w-3.5 shrink-0", stateClass, row.state === "running" && "pulse-dot")} strokeWidth={1.9} aria-hidden="true" />;
}

/** Map the truthful task-node state (Issue #624) to a timeline row state. */
function nodeStateToRowState(state: TaskNodeState, interrupted: boolean): RowState {
  if (interrupted && state === "running") return "interrupted";
  switch (state) {
    case "succeeded":
      return "done";
    case "failed":
      return "blocked";
    case "cancelled":
      return "cancelled";
    case "queued":
      return "queued";
    case "running":
    default:
      return "running";
  }
}

function DomainChip({ hostname }: { hostname: string }) {
  return (
    <span
      aria-label={hostname}
      className="inline-flex max-w-full items-center gap-1 rounded-full bg-ink/[0.04] px-1.5 py-0.5 align-middle font-mono text-[11px] leading-none text-ink/34 transition-colors hover:bg-ink/[0.07] hover:text-ink/50"
    >
      <span className="h-1 w-1 shrink-0 rounded-full bg-ink/25" />
      <span className="truncate">{hostname}</span>
    </span>
  );
}

function SourceDot({ hostname, overlap }: { hostname: string | null; overlap: boolean }) {
  const letter = (hostname ?? "•").charAt(0).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-ink/[0.08] text-[8.5px] font-semibold leading-none text-ink/45",
        overlap && "-ml-1.5",
      )}
      style={{ boxShadow: "0 0 0 1.5px var(--app-bg)" }}
    >
      {letter}
    </span>
  );
}

function ActivityGroupRow({ row, onOpenSources }: { row: TimelineRow; onOpenSources?: OpenSourcesHandler }) {
  const [open, setOpen] = useState(false);
  const group = row.activityGroup;
  if (!group) return null;
  const depth = row.depth ?? 0;
  const hasSources = group.sources.length > 0;
  const depthPadding = depth > 0 ? { paddingLeft: `${0.75 + depth * 1.15}rem` } : undefined;
  return (
    <div data-testid="execution-activity-group" data-depth={depth} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        disabled={!hasSources}
        onClick={() => setOpen((value) => !value)}
        // Same flush-left contract as TimelineRowView roots — without the
        // marker a depth-0 activity group keeps pl-3 inside the embedded
        // fold while its sibling rows go flush (review finding 2026-07-19).
        data-row-root={depth === 0 ? "" : undefined}
        className={cn(
          "flex w-full min-w-0 items-baseline gap-2 rounded-md pl-3 pr-1 text-left",
          hasSources && "transition-colors hover:bg-ink/[0.03]",
        )}
        style={depthPadding}
      >
        <span aria-hidden="true" className="flex w-[15px] shrink-0 items-center self-center">
          {row.kind === "read" ? (
            <Globe className={cn("h-3.5 w-3.5", row.state === "running" ? "text-activity pulse-dot" : "text-ink/30")} strokeWidth={1.9} />
          ) : (
            <Search className={cn("h-3.5 w-3.5", row.state === "running" ? "text-activity pulse-dot" : "text-ink/30")} strokeWidth={1.9} />
          )}
        </span>
        {/* Content hugs the label — pushing the favicon stack to the card's
            far edge tore a void through the middle of every wide row. */}
        <span className="min-w-0 truncate text-[12.5px] font-medium leading-5 text-ink/55">{row.label}</span>
        {hasSources && (
          <span className="inline-flex shrink-0 items-center self-center" aria-hidden="true">
            {group.sources.slice(0, 5).map((source, index) => (
              <SourceDot key={source.url} hostname={source.hostname} overlap={index > 0} />
            ))}
            {group.sources.length > 5 && (
              <span className="ml-1 text-[10.5px] tabular-nums text-ink/30">+{group.sources.length - 5}</span>
            )}
          </span>
        )}
        {hasSources && (
          <ChevronRight
            aria-hidden="true"
            className={cn("h-3 w-3 shrink-0 self-center text-ink/25 transition-transform", open && "rotate-90")}
          />
        )}
      </button>
      {open && hasSources && (
        <ul
          data-testid="execution-source-list"
          aria-label={group.sourceListLabel}
          className="mt-0.5 flex list-none flex-col gap-px pl-8"
          style={depth > 0 ? { paddingLeft: `${2 + depth * 1.15}rem` } : undefined}
        >
          {group.sources.map((source) => (
            <li key={source.url} className="min-w-0">
              <a
                data-testid="execution-source-link"
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group/source flex min-w-0 items-baseline gap-2 rounded-md px-2 py-1 text-[12px] leading-5 text-ink/45 transition-colors hover:bg-ink/[0.04] hover:text-ink/70"
              >
                <span className="min-w-0 flex-1 truncate">{source.title ?? source.hostname ?? source.url}</span>
                {source.hostname && <DomainChip hostname={source.hostname} />}
                <ExternalLink
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 self-center text-ink/25 opacity-0 transition-opacity group-hover/source:opacity-100"
                />
              </a>
            </li>
          ))}
          {onOpenSources && (
            <li className="min-w-0">
              <button
                type="button"
                data-testid="execution-source-open-all"
                onClick={() => onOpenSources(group.sources, row.label)}
                className="rounded-md px-2 py-1 text-[12px] leading-5 text-ink/35 transition-colors hover:bg-ink/[0.04] hover:text-link"
              >
                {group.openAllLabel}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

type RowDisclosure = { expanded: boolean; onToggle: () => void };

function TimelineRowView({ row, onOpenSources, disclosure }: { row: TimelineRow; onOpenSources?: OpenSourcesHandler; disclosure?: RowDisclosure }) {
  if (row.activityGroup) return <ActivityGroupRow row={row} onOpenSources={onOpenSources} />;
  // Indent nested task-timeline rows (Issue #624). Depth 0 keeps the original
  // pl-3; each level adds a fixed step so a subtask/tool reads as owned by its
  // parent group without depending on the client clock or arrival order.
  const depth = row.depth ?? 0;
  // A group row that owns child rows is itself the disclosure toggle
  // (per-phase expansion) — same affordance as ActivityGroupRow: full-row
  // hover surface plus a trailing chevron that rotates open.
  const RowShell = disclosure ? "button" : "div";
  const shellProps = disclosure
    ? {
        type: "button" as const,
        "data-testid": "execution-task-group",
        "aria-expanded": disclosure.expanded,
        onClick: disclosure.onToggle,
      }
    : { "data-testid": row.isGroup ? "execution-task-group" : undefined };
  return (
    <RowShell
      {...shellProps}
      data-depth={depth}
      // Presence marker for top-level rows: the EMBEDDED (turn-fold) wrapper
      // strips their base indent so the process content sits flush with the
      // fold's left edge (operator report 2026-07-19: "步骤左侧对齐").
      data-row-root={depth === 0 ? "" : undefined}
      className={cn(
        "flex min-w-0 items-baseline gap-2 pl-3",
        disclosure && "w-full rounded-md pr-1 text-left transition-colors hover:bg-ink/[0.03]",
      )}
      style={depth > 0 ? { paddingLeft: `${0.75 + depth * 1.15}rem` } : undefined}
    >
      <span aria-hidden="true" className="flex w-[15px] shrink-0 items-center self-start pt-[3px]">
        {row.isGroup ? <GroupStateIcon state={row.state} /> : <LeafKindIcon row={row} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p
            data-testid="execution-step-label"
            // The marker lets the EMBEDDED (turn-fold) wrapper step these rows
            // down one size — inside 查看处理过程 the to-dos must not read at
            // answer size (operator report 2026-07-19).
            data-plan-step={row.isGroup && !row.isSkillActivation ? "" : undefined}
            className={cn(
              "min-w-0 flex-1 text-[12.5px] leading-5",
              row.isSkillActivation ? "font-mono font-semibold text-ink/62" : "text-ink/45",
              // Group (plan-phase/task) rows read at BODY size with the state
              // written into the text itself (operator decision 2026-07-19,
              // competitor parity): the list is the assistant crossing off its
              // own to-dos, not a status console. running = brighter medium,
              // done = struck through and receded, pending = quiet regular.
              row.isGroup && !row.isSkillActivation && "text-[15px] leading-[1.6]",
              row.isGroup && !row.isSkillActivation && row.state === "running" && "font-medium text-ink/90",
              row.isGroup && !row.isSkillActivation && row.state === "done" && "text-ink/32 line-through decoration-ink/20",
              row.isGroup && !row.isSkillActivation && row.state !== "running" && row.state !== "done" && "text-ink/45",
            )}
          >
            {row.label}
            {(row.repeatCount ?? 1) > 1 && (
              <span data-testid="execution-repeat-count" className="ml-1.5 text-[11px] tabular-nums text-ink/28">
                ×{row.repeatCount}
              </span>
            )}
            {row.skillSuffixName && (
              <span
                data-testid="execution-skill-suffix"
                className="ml-1.5 inline-flex max-w-full items-center rounded-full bg-ink/[0.04] px-1.5 py-0.5 align-middle text-[10.5px] leading-none text-ink/30"
              >
                ❖ {row.skillSuffixName}
              </span>
            )}
            {row.url && row.hostname && row.showHostnameChip && (
              <>
                {" "}
                <span className="ml-1.5">
                  <DomainChip hostname={row.hostname} />
                </span>
              </>
            )}
          </p>
        </div>
        {row.detail && (
          <p
            data-testid={row.isSkillActivation ? "execution-skill-detail" : undefined}
            className={cn(
              "mt-0.5 break-words text-[11.5px] leading-5 text-ink/30",
              row.isSkillActivation && "pl-0 font-normal",
            )}
          >
            {row.isSkillActivation ? `⌊ ${row.detail}` : row.detail}
          </p>
        )}
        {row.resultDetail && disclosure?.expanded && (
          <p
            data-testid="execution-step-result"
            className="mt-1 whitespace-pre-wrap break-words text-[11.5px] leading-5 text-ink/38"
          >
            {row.resultDetail}
          </p>
        )}
      </div>
      {disclosure && (
        <ChevronRight
          aria-hidden="true"
          className={cn("h-3 w-3 shrink-0 self-center text-ink/25 transition-transform", disclosure.expanded && "rotate-90")}
        />
      )}
    </RowShell>
  );
}

export function TechnicalDetails({ block, locale }: { block: ExecutionBlockModel; locale: Locale }) {
  const [expanded, setExpanded] = useState(false);
  const tools = getDisplayTools(block.tools);
  // A completed step's `detail` is its result excerpt — already disclosed on
  // the plan-card row itself. Repeating 400-char excerpts here would drown
  // the panel's purpose (raw lifecycle truth), so completed tasks surface
  // only their rawStatus.
  const technicalDetailFor = (task: TaskUpdate): string | undefined =>
    task.status === "completed" ? task.rawStatus : task.detail || task.rawStatus;
  const taskDetails = block.tasks.filter((task) => technicalDetailFor(task));

  if (tools.length === 0 && taskDetails.length === 0) return null;

  return (
    <div className="mt-3 border-t border-ink/[0.06] pt-2">
      <button
        type="button"
        data-testid="execution-technical-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex items-center gap-1.5 text-[11.5px] text-ink/32 transition-colors hover:text-ink/52"
      >
        <ChevronDown size={12} className={cn("transition-transform duration-180ms", expanded && "rotate-180")} />
        {translateMessage(locale, "execution.details.technical")}
      </button>
      {expanded && (
        <div data-testid="execution-technical-details" className="mt-2 space-y-2 border-l border-ink/[0.07] pl-3 font-mono text-[10.5px] leading-5 text-ink/35">
          {tools.map((tool) => (
            <dl key={`technical:${tool.callId || tool.id}`} className="space-y-0.5 break-words">
              <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.toolName")}: </dt><dd className="inline">{tool.tool || "unknown"}</dd></div>
              {tool.intent && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.intent")}: </dt><dd className="inline whitespace-pre-wrap">{tool.intent}</dd></div>}
              {tool.elapsed_ms != null && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.duration")}: </dt><dd className="inline">{formatDurationForLocale(tool.elapsed_ms, locale)}</dd></div>}
              {tool.skillName && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.skillId")}: </dt><dd className="inline">{tool.skillName}</dd></div>}
              {tool.error && <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.error")}: </dt><dd className="inline whitespace-pre-wrap">{tool.error}</dd></div>}
              {(tool.skillMissingBins?.length || tool.skillMissingEnv?.length) ? (
                <div><dt className="inline text-ink/24">{translateMessage(locale, "execution.details.missing")}: </dt><dd className="inline">{[...(tool.skillMissingBins ?? []), ...(tool.skillMissingEnv ?? [])].join(", ")}</dd></div>
              ) : null}
            </dl>
          ))}
          {taskDetails.map((task) => (
            <div key={`technical-task:${task.id}`} className="break-words">
              <span className="text-ink/24">{translateMessage(locale, "execution.details.taskDetail")}: </span>
              {technicalDetailFor(task)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function startedAtMs(block: ExecutionBlockModel): number | null {
  const stamps = [...block.tasks, ...block.tools]
    .map((item) => item.timestamp)
    .filter((value): value is number => typeof value === "number" && value > 1_000_000_000_000);
  return stamps.length ? Math.min(...stamps) : null;
}

function liveLabel(block: ExecutionBlockModel, locale: Locale): string {
  const runningTool = [...getDisplayTools(block.tools)].reverse().find((tool) => tool.phase === "start");
  if (runningTool) {
    const summary = buildToolStepSummary(runningTool, locale);
    if (summary.isSkillActivation) return toolRunningActionLabel(runningTool.tool, locale, summary.skillName);
    if (summary.kind === "shell") return translateMessage(locale, "execution.step.runFallback");
    if (summary.kind === "write") return translateMessage(locale, "execution.step.writeFallback");
    if (summary.kind === "inspect") return translateMessage(locale, "execution.step.inspectFallback");
    return summary.label;
  }

  const runningTask = [...block.tasks].reverse().find((task) => task.status === "running" || task.status === "pending");
  if (runningTask) {
    const title = sanitizeTaskTitle(runningTask.title);
    const status = taskUserStatusLabel(runningTask.userStatus, locale, runningTask.status);
    if (title && status && title !== status && !isTurnLifecycleTask(runningTask)) {
      return translateMessage(locale, "execution.step.currentTask", { name: title, detail: status });
    }
    return status || title || translateMessage(locale, "execution.summary.runningCompact");
  }

  return block.headline || translateMessage(locale, "execution.summary.runningCompact");
}

function LiveExecutionLine({ block, locale }: { block: ExecutionBlockModel; locale: Locale }) {
  const start = useMemo(() => startedAtMs(block), [block]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!start) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [start]);

  const elapsedMs = start ? Math.max(0, Math.floor((now - start) / 60_000) * 60_000) : null;
  const approximateDuration = elapsedMs == null ? null : formatApproximateDurationForLocale(elapsedMs, locale);

  return (
    <div data-testid="execution-live-line" className="flex w-full max-w-[640px] items-center gap-2 py-1.5 text-[12px] text-ink/42">
      <Loader2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-activity" strokeWidth={2} />
      <span className="live-verb-shimmer min-w-0 truncate">{liveLabel(block, locale)}</span>
      <span className="flex-1" />
      {approximateDuration && (
        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-ink/22">
          {approximateDuration}
        </span>
      )}
    </div>
  );
}

export function ExecutionBlock({ block, interrupted = false, embedded = false, onOpenSources, suppressTechnicalDetails = false }: ExecutionBlockProps) {
  const { locale: uiLocale } = useLocale();
  const locale = block.locale ?? uiLocale;
  const [expanded, setExpanded] = useState(false);
  // The turn envelope may have terminalized this block as crash-interrupted
  // (Issue #626); treat that exactly like a runtime-lost block so running rows
  // freeze into the explicit interrupted state instead of spinning.
  const frozen = interrupted || block.status === "interrupted";
  const isLive = block.status === "running" && !frozen;
  const rows = useMemo(() => getTimelineRows(block, locale, frozen), [block, locale, frozen]);
  const summary = compactSummary(block, frozen, locale);
  const shouldScrollTimeline = rows.length > EXECUTION_TIMELINE_SCROLL_THRESHOLD;

  if (isLive) {
    // EVERY working turn with process content shows the same collapsed
    // capsule (four-region model, operator decision 2026-07-18): the plan is
    // not special — it just adds phase rows and a progress bar. The capsule
    // is the single live narrator (#635 single status owner); no extra
    // activity line, no default-open row dump.
    if (rows.length > 0) {
      // Phases that have not started yet have no task/tool rows — show them
      // as queued so the whole plan is visible when expanded (mockup parity).
      const startedPhaseIds = new Set(block.tasks.map((task) => task.task_id));
      const queuedRows: TimelineRow[] = (block.plan?.phases ?? [])
        .filter((phase) => !startedPhaseIds.has(phase.taskId))
        .map((phase) => ({
          key: `plan-queued:${phase.taskId}`,
          label: sanitizeTaskTitle(phase.title) || phase.title,
          state: "queued" as RowState,
          depth: 0,
          isGroup: true,
          timestamp: Number.MAX_SAFE_INTEGER,
        }));
      return <LiveWorkCapsule block={block} locale={locale} rows={[...rows, ...queuedRows]} onOpenSources={onOpenSources} />;
    }
    // Nothing observable yet (lifecycle-only) — the one-line status suffices.
    return <LiveExecutionLine block={block} locale={locale} />;
  }

  if (embedded) {
    return (
      // Inside the turn fold everything is subordinate to the answer: plan
      // to-do rows step down from body size (they keep 15px only on the LIVE
      // capsule, where they are the turn's hero surface), and top-level rows
      // sit flush with the fold's left edge instead of carrying the plan
      // card's inset.
      <div
        data-testid="execution-block-embedded"
        className="w-full max-w-[640px] [&_[data-plan-step]]:!text-[13px] [&_[data-plan-step]]:!leading-[1.55] [&_[data-row-root]]:!pl-0 [&_[data-testid=execution-plan-card]]:!px-0"
      >
        {rows.length > 0 && (() => {
          // Embedded inside the turn fold (already in the page scroll) — never
          // add a nested max-height scroll box, or the user has to scroll a
          // small inner pane separately to see the whole process.
          const progress = planProgress(block);
          if (progress) {
            // Plan turns keep the two-level disclosure in the fold too: phase
            // spine first, tool rows behind the details toggle.
            return (
              <PlanCardShell locale={locale} verifying={planVerifying(block)}>
                <div data-testid="execution-timeline" className="py-0.5">
                  <PlanTimelineBody rows={rows} onOpenSources={onOpenSources} />
                </div>
              </PlanCardShell>
            );
          }
          return (
            <div data-testid="execution-timeline" className="space-y-1.5 py-0.5">
              {rows.map((row) => (
                <TimelineRowView key={row.key} row={row} onOpenSources={onOpenSources} />
              ))}
            </div>
          );
        })()}
        {!suppressTechnicalDetails && <TechnicalDetails block={block} locale={locale} />}
      </div>
    );
  }

  return (
    <div data-testid="execution-block" className="w-full max-w-[640px] py-1">
      <button
        type="button"
        data-testid="execution-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="inline-flex max-w-full items-center gap-2 px-1 py-1 text-[12px] leading-none text-ink/35 transition-colors duration-180ms hover:text-ink/55"
      >
        <span className="truncate">{summary}</span>
        <ChevronDown size={12} className={cn("shrink-0 text-ink/25 transition-transform duration-180ms", expanded && "rotate-180")} />
      </button>

      {expanded && rows.length > 0 && (() => {
        const progress = planProgress(block);
        const timeline = (
          <div
            data-testid="execution-timeline"
            className={cn(
              "space-y-1.5 py-0.5",
              !progress && "border-l border-ink/[0.07]",
              shouldScrollTimeline && "max-h-[320px] overflow-y-auto pr-1",
            )}
          >
            {rows.map((row) => (
              <TimelineRowView key={row.key} row={row} onOpenSources={onOpenSources} />
            ))}
          </div>
        );
        return (
          <div className="mt-2.5 duration-180ms motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1">
            {progress ? (
              <PlanCardShell locale={locale} verifying={planVerifying(block)}>
                <PlanTimelineBody rows={rows} onOpenSources={onOpenSources} />
              </PlanCardShell>
            ) : (
              timeline
            )}
            <TechnicalDetails block={block} locale={locale} />
          </div>
        );
      })()}
    </div>
  );
}

/**
 * Structural equality for the JSON-like values that make up an
 * `ExecutionBlockModel` (primitives, arrays, and plain server-carried objects —
 * no functions, class instances, Maps, or Sets). Used only by the memo
 * comparator below.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i += 1) {
      if (!deepEqual(aArr[i], bArr[i])) return false;
    }
    return true;
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Custom memo comparator (Issue #628).
 *
 * `projectTimelineByTurn` rebuilds every execution block's wrapper object — and
 * its `tasks` / `tools` / `issueSummaries` arrays — on every projection, even
 * for historical turns whose content never changed. React's default shallow
 * prop compare sees a fresh `block` reference for each block and re-renders the
 * ENTIRE turn history on every active-turn update (a new tool event, a ticking
 * elapsed time, an auto-follow scroll toggle). Comparing block content
 * structurally instead keeps unchanged historical blocks parked at their last
 * render while the one active block whose content actually changed still
 * re-renders.
 *
 * Cheap scalar fields are compared first so the common case — the active block,
 * which almost always differs in `status`/`toolCount`/`totalElapsedMs` — rejects
 * without walking the arrays. `interrupted` is normalized to its defaulted value
 * so `undefined` and an explicit `false` are treated as equal.
 */
export function areExecutionBlockPropsEqual(prev: ExecutionBlockProps, next: ExecutionBlockProps): boolean {
  if ((prev.interrupted ?? false) !== (next.interrupted ?? false)) return false;
  // Callback identity matters: a new handler must re-render so rows bind it.
  if (prev.onOpenSources !== next.onOpenSources) return false;
  if ((prev.suppressTechnicalDetails ?? false) !== (next.suppressTechnicalDetails ?? false)) return false;
  const a = prev.block;
  const b = next.block;
  if (a === b) return true;
  return (
    a.key === b.key &&
    a.turnId === b.turnId &&
    a.locale === b.locale &&
    a.headline === b.headline &&
    a.status === b.status &&
    a.toolCount === b.toolCount &&
    a.taskCount === b.taskCount &&
    a.issueCount === b.issueCount &&
    a.totalElapsedMs === b.totalElapsedMs &&
    deepEqual(a.issueSummaries, b.issueSummaries) &&
    deepEqual(a.tasks, b.tasks) &&
    deepEqual(a.tools, b.tools) &&
    deepEqual(a.plan, b.plan)
  );
}

/**
 * Memoized with a content-aware comparator (Issue #628) because the projection
 * rebuilds block objects on every active update; see
 * `areExecutionBlockPropsEqual`. This lets a stable parent re-render (scroll
 * auto-follow, a sibling turn's live update) skip every historical block's
 * subtree while the active block still tracks its own changes.
 */
export default memo(ExecutionBlock, areExecutionBlockPropsEqual);
