import type { Artifact, ChatMessage, PlanStartedUpdate, TimelineItem, ToolEvent, TaskUpdate } from "@/types";
import { DEFAULT_LOCALE, translateMessage, type Locale, type MessageKey } from "@/i18n/messages";

/**
 * Block-level lifecycle status. `running`/`success`/`error`/`mixed` are derived
 * from the tools/tasks a block contains. `cancelled`/`interrupted` are NOT derived
 * locally — they are stamped by the deterministic projection from the durable Turn
 * Envelope (Issue #626) so a stop or a crash-interrupted turn renders truthfully on
 * restore instead of spinning forever or masquerading as a plain failure.
 */
export type ExecutionState = "running" | "success" | "error" | "mixed" | "cancelled" | "interrupted";

export interface ExecutionIssueSummary {
  key: string;
  label: string;
  detail: string;
  count: number;
  latestTimestamp: number;
}

export interface ExecutionBlockModel {
  key: string;
  turnId?: string;
  locale?: Locale;
  headline: string;
  status: ExecutionState;
  toolCount: number;
  taskCount: number;
  issueCount: number;
  totalElapsedMs: number;
  issueSummaries: ExecutionIssueSummary[];
  tasks: TaskUpdate[];
  tools: ToolEvent[];
  /**
   * Typed plan structure for this block's turn (Issue #735), when the runtime
   * admitted a background plan. Presentation source for phase names and
   * dependency state — never re-parsed from prose.
   */
  plan?: PlanStartedUpdate;
}

export type ChatRenderItem =
  | { kind: "single"; item: TimelineItem; index: number }
  | { kind: "execution"; block: ExecutionBlockModel };

export type ToolStepKind = "search" | "read" | "shell" | "write" | "inspect" | "skill" | "generic";

/** One web source a step consulted, ready for the source list UI. */
export interface ExecutionSourceRef {
  title: string | null;
  url: string;
  snippet: string | null;
  hostname: string | null;
}
export type SkillLoadOutcome = "success" | "not_found" | "ineligible";

export interface ToolStepSummary {
  kind: ToolStepKind;
  label: string;
  timelineLabel: string;
  target: string | null;
  url: string | null;
  hostname: string | null;
  showHostnameChip: boolean;
  raw: string | null;
  skillName: string | null;
  skillDescription: string | null;
  skillLoadOutcome: SkillLoadOutcome | null;
  skillMissingBins: string[];
  skillMissingEnv: string[];
  skillLoadError: string | null;
  skillSuffixName: string | null;
  isSkillActivation: boolean;
  /** Web sources this step consulted (structured payload, or the step URL as fallback). */
  sources: ExecutionSourceRef[];
}

function getToolState(event: ToolEvent): "running" | "success" | "error" {
  if (event.phase === "start") return "running";
  return event.status === "error" ? "error" : "success";
}

/**
 * A search that simply found nothing is normal research friction — the agent
 * tried a query and moved on. Surfacing "no useful results" as an alarming "needs
 * attention" warning makes a working agent look broken, so it is benign: excluded
 * from the issue count, the collapsed warning, and the error status.
 *
 * Note: this is deliberately narrow. A source that was unreachable (5xx/timeout)
 * or unreadable stays a real, shown issue — only the empty-result case is muted.
 */
function isBenignToolFailureDetail(detail: string): boolean {
  return compactIssueDetail(detail) === "Search returned no useful results";
}

function isBenignToolFailure(tool: ToolEvent): boolean {
  if (getToolState(tool) !== "error") return false;
  return isBenignToolFailureDetail(tool.error || tool.result || "");
}

function getExecutionTurnId(item: TimelineItem): string | undefined {
  if (item.type === "tool_event") return (item.data as ToolEvent).turnId;
  if (item.type === "task_update") return (item.data as TaskUpdate).turnId;
  if (item.type === "plan_started") return (item.data as PlanStartedUpdate).turnId;
  return undefined;
}

function getExecutionTaskId(item: TimelineItem): string | undefined {
  if (item.type === "tool_event") return (item.data as ToolEvent).taskId;
  if (item.type === "task_update") return (item.data as TaskUpdate).task_id;
  if (item.type === "plan_started") return (item.data as PlanStartedUpdate).plan_id;
  return undefined;
}

function getHeadline(tasks: TaskUpdate[], tools: ToolEvent[], status: ExecutionState): string {
  const latestRunningTask = [...tasks].reverse().find((task) => task.status === "running");
  if (latestRunningTask) return sanitizeTaskTitle(latestRunningTask.title);

  const latestIntent = [...tools].reverse().find((tool) => sanitizeToolIntent(tool.intent));
  const intent = sanitizeToolIntent(latestIntent?.intent);
  if (intent) return intent;

  const latestTask = [...tasks].reverse().find((task) => sanitizeTaskTitle(task.title));
  if (latestTask) return sanitizeTaskTitle(latestTask.title);

  const latestTool = [...tools].reverse()[0];
  if (latestTool) return toolActionLabel(latestTool.tool);

  if (status === "running") return translateMessage(DEFAULT_LOCALE, "execution.headline.working");
  if (status === "error") return translateMessage(DEFAULT_LOCALE, "execution.headline.failed");
  if (status === "mixed") return translateMessage(DEFAULT_LOCALE, "execution.headline.mixed");
  if (status === "cancelled") return translateMessage(DEFAULT_LOCALE, "execution.headline.cancelled");
  if (status === "interrupted") return translateMessage(DEFAULT_LOCALE, "execution.headline.interrupted");
  return translateMessage(DEFAULT_LOCALE, "execution.headline.completed");
}

/**
 * A user-cancelled task is terminal but NOT a failure (Issue #624): the 4-state
 * `status` collapses cancelled → failed, so `rawStatus` is the truthful signal.
 * Cancellation must not inflate the issue count or force an error summary — that
 * would report a deliberate stop as something broken.
 */
export function isCancelledTask(task: TaskUpdate): boolean {
  return typeof task.rawStatus === "string" && /cancel/i.test(task.rawStatus);
}

function getExecutionState(tasks: TaskUpdate[], tools: ToolEvent[]): ExecutionState {
  const taskStates = tasks.map((task) => (isCancelledTask(task) ? "completed" : task.status));
  // Benign tool outcomes (empty search, unreadable source) count as success so a
  // turn that found its answer despite some dead ends still reads as complete.
  const toolStates = tools.map((tool) => (isBenignToolFailure(tool) ? "success" : getToolState(tool)));
  const states = [...taskStates, ...toolStates];

  if (states.some((state) => state === "running" || state === "pending")) return "running";

  const hasError = states.some((state) => state === "failed" || state === "error");
  const hasSuccess = states.some((state) => state === "completed" || state === "success");

  if (hasError && hasSuccess) return "mixed";
  if (hasError) return "error";
  return "success";
}

function getArtifactCoveredTurnIds(timeline: TimelineItem[]): Set<string> {
  const turnIds = new Set<string>();

  for (const item of timeline) {
    if (item.type !== "artifact") continue;
    const artifact = item.data as Artifact;
    // Only a dedicated live-work surface, which renders the tool activity
    // itself, truly replaces the turn's execution blocks. A streamed
    // document/report artifact also sets `live_preview` but does NOT show the
    // underlying searches/fetches — suppressing them there erased the visible
    // work and collapsed the finished turn into a jarring blank.
    const coversExecution =
      artifact.plugin_id === "workspace_hub_v1" ||
      artifact.plugin_id === "live_work_v1";
    if (!coversExecution) continue;
    const meta = artifact.data.meta as { turn_id?: string } | undefined;
    if (typeof meta?.turn_id === "string" && meta.turn_id.trim()) {
      turnIds.add(meta.turn_id);
    }
  }

  return turnIds;
}

function canAppendToExecutionBlock(
  active: { turnId?: string; taskIds: Set<string>; items: TimelineItem[] },
  item: TimelineItem,
): boolean {
  const nextTurnId = getExecutionTurnId(item);
  const nextTaskId = getExecutionTaskId(item);

  if (active.turnId && nextTurnId) return active.turnId === nextTurnId;
  if (!active.turnId && !nextTurnId) return true;
  if (nextTaskId && active.taskIds.has(nextTaskId)) return true;
  return !active.turnId || !nextTurnId;
}

export function isExecutionTimelineItem(item?: TimelineItem | null): boolean {
  // plan_started rides in the execution run of its turn: it is process
  // structure, not conversation content, and grouping it here also keeps the
  // legacy (frozen) renderer from ever passing it to the single-item renderer.
  return item?.type === "tool_event" || item?.type === "task_update" || item?.type === "plan_started";
}

export function isTurnLifecycleTask(task: TaskUpdate): boolean {
  return (
    (
      task.userStatus === "received" ||
      task.userStatus === "planning" ||
      task.userStatus === "working" ||
      task.userStatus === "responding"
    ) &&
    /:(received|planning|working|responding|failed)$/.test(task.task_id)
  );
}

function getConcreteExecutionTurnIds(timeline: TimelineItem[]): Set<string> {
  const turnIds = new Set<string>();

  for (const item of timeline) {
    const turnId = getExecutionTurnId(item);
    if (!turnId) continue;

    if (isConcreteExecutionItem(item)) {
      turnIds.add(turnId);
    }
  }

  return turnIds;
}

function isConcreteExecutionItem(item: TimelineItem): boolean {
  if (item.type === "tool_event") return true;
  if (item.type === "plan_started") return true;
  if (item.type === "task_update" && !isTurnLifecycleTask(item.data as TaskUpdate)) return true;
  return false;
}

function isVisibleAssistantMessage(item?: TimelineItem | null): boolean {
  if (item?.type !== "message") return false;
  const data = item.data as { role?: string; content?: string };
  return data.role === "assistant" && (data.content ?? "").trim().length > 0;
}

function isVisibleUserMessage(item?: TimelineItem | null): boolean {
  if (item?.type !== "message") return false;
  const data = item.data as { role?: string; content?: string };
  return data.role === "user" && (data.content ?? "").trim().length > 0;
}

export function inferMessageLocale(content?: string | null): Locale | undefined {
  const value = (content ?? "").trim();
  if (!value) return undefined;
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(value)) return undefined;
  if (/[\u4e00-\u9fff]/u.test(value)) return "zh-CN";
  if (/[A-Za-z]/.test(value)) return "en";
  return undefined;
}

function getTimelineConversationSegments(timeline: TimelineItem[]): number[] {
  const segments: number[] = [];
  let segment = -1;

  for (let i = 0; i < timeline.length; i++) {
    if (isVisibleUserMessage(timeline[i])) {
      segment += 1;
    }
    segments[i] = segment;
  }

  return segments;
}

function getTimelineConversationLocales(timeline: TimelineItem[]): Array<Locale | undefined> {
  const locales: Array<Locale | undefined> = [];
  let current: Locale | undefined;

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (isVisibleUserMessage(item)) {
      const data = item.data as { content?: string };
      current = inferMessageLocale(data.content) ?? current;
    }
    locales[i] = current;
  }

  return locales;
}

function getConcreteExecutionSegments(timeline: TimelineItem[], segments: number[]): Set<number> {
  const concreteSegments = new Set<number>();

  for (let i = 0; i < timeline.length; i++) {
    const segment = segments[i];
    if (segment < 0) continue;
    if (isConcreteExecutionItem(timeline[i])) concreteSegments.add(segment);
  }

  return concreteSegments;
}

function isCompletedLifecycleOnlyBlock(block: ExecutionBlockModel): boolean {
  return (
    block.status === "success" &&
    block.issueCount === 0 &&
    block.toolCount === 0 &&
    block.tasks.length > 0 &&
    block.tasks.every(isTurnLifecycleTask)
  );
}

function isNoisyLifecycleOnlyBlock(block: ExecutionBlockModel): boolean {
  return (
    block.issueCount === 0 &&
    block.toolCount === 0 &&
    block.tasks.length > 0 &&
    block.tasks.every(isTurnLifecycleTask)
  );
}

function getLatestRenderedSingleItem(renderItems: ChatRenderItem[]): TimelineItem | null {
  for (let i = renderItems.length - 1; i >= 0; i--) {
    const item = renderItems[i];
    if (item.kind === "single") return item.item;
  }
  return null;
}

export function shouldRenderExecutionBlock(
  block: ExecutionBlockModel,
  nextItem?: TimelineItem | null,
  previousItem?: TimelineItem | null,
): boolean {
  if (isVisibleAssistantMessage(previousItem) && isCompletedLifecycleOnlyBlock(block)) return false;
  if (!previousItem && isVisibleUserMessage(nextItem) && isCompletedLifecycleOnlyBlock(block)) return false;

  if (block.status === "running" || block.status === "error" || block.status === "mixed") return true;
  if (block.issueCount > 0) return true;

  const nonLifecycleTaskCount = block.tasks.filter((task) => !isTurnLifecycleTask(task)).length;
  if (nonLifecycleTaskCount > 0) return true;
  if (block.totalElapsedMs >= 60_000) return true;

  // A block preceded by interim narration belongs to a multi-phase turn: keep
  // it as process detail for the turn fold. A lone incidental block whose
  // answer follows leaves no residue at all.
  if (isVisibleAssistantMessage(previousItem)) return true;
  return !isVisibleAssistantMessage(nextItem);
}

export function sanitizeTaskTitle(title?: string | null): string {
  return (title ?? "")
    .replace(/^\s*\[[^\]]+\]\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeToolIntent(intent?: string): string | null {
  const value = intent?.replace(/\s+/g, " ").trim();
  if (!value) return null;

  const looksLikeRuntimeId =
    /^[a-z]+_[0-9]{8,}_[a-z0-9]+$/i.test(value) ||
    (/^[a-z0-9_:-]+$/i.test(value) && /[_:-]/.test(value) && /\d{6,}/.test(value));
  return looksLikeRuntimeId ? null : value;
}

export function compactIssueDetail(detail: string): string {
  const cleaned = detail
    .replace(/^Error:\s*/i, "")
    .replace(/^[\w ]+ failed\s+[—-]\s*/i, "")
    .split(/\s+IMPORTANT:\s+/i)[0]
    .replace(/\b([A-Z][A-Z0-9_]+)\s+environment variable is not set\b/g, "Missing $1")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "";

  if (
    /\b(crawl api error|failed to crawl url|crawl service failed)\b/i.test(cleaned) ||
    /\bstatus\s+50[0-4]\b/i.test(cleaned)
  ) {
    return "Source temporarily unavailable";
  }

  if (/\b(search api error|no results found for query)\b/i.test(cleaned)) {
    return /\bno results found for query\b/i.test(cleaned)
      ? "Search returned no useful results"
      : "Search service temporarily unavailable";
  }

  if (/\b(status\s+(403|404|429)|timeout|timed out|failed to fetch|network error)\b/i.test(cleaned)) {
    return "Source could not be read";
  }

  // Local filesystem/script noise: raw ENOENT paths and stderr dumps are
  // technical detail — the default layer states what happened in one phrase
  // and the raw text stays reachable in Technical details.
  if (/\bENOENT\b|no such file or directory/i.test(cleaned)) {
    return "File not found";
  }
  if (/\bstderr\b|\bSyntaxError\b|Traceback \(most recent call last\)/i.test(cleaned)) {
    return "Command reported errors";
  }

  return cleaned;
}

export function buildExecutionIssueSummaries(tasks: TaskUpdate[], tools: ToolEvent[]): ExecutionIssueSummary[] {
  const grouped = new Map<string, ExecutionIssueSummary>();

  const addIssue = (label: string, detail: string, timestamp: number) => {
    const compactDetail = compactIssueDetail(detail);
    if (!compactDetail) return;
    const key = `${label}:${compactDetail.toLowerCase()}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count += 1;
      existing.latestTimestamp = Math.max(existing.latestTimestamp, timestamp);
      return;
    }
    grouped.set(key, {
      key,
      label,
      detail: compactDetail,
      count: 1,
      latestTimestamp: timestamp,
    });
  };

  for (const task of tasks) {
    if (task.status !== "failed" || isCancelledTask(task)) continue;
    addIssue(
      sanitizeTaskTitle(task.title) || translateMessage(DEFAULT_LOCALE, "execution.issue.workStep"),
      task.detail || task.rawStatus || translateMessage(DEFAULT_LOCALE, "execution.issue.stepFailed"),
      task.timestamp,
    );
  }

  for (const tool of tools) {
    if (getToolState(tool) !== "error") continue;
    if (isBenignToolFailure(tool)) continue; // empty result / unreadable source — not an alarm
    addIssue(
      toolUserActionLabel(tool.tool),
      tool.error || tool.result || translateMessage(DEFAULT_LOCALE, "execution.issue.toolFailed"),
      tool.timestamp,
    );
  }

  return [...grouped.values()].sort((a, b) => b.latestTimestamp - a.latestTimestamp);
}

function normalizeToolName(tool?: string | null): string {
  return typeof tool === "string" && tool.trim() ? tool.trim() : "task_step";
}

export function toolDisplayLabel(tool?: string | null): string {
  return toolDisplayLabelForLocale(tool, DEFAULT_LOCALE);
}

export function toolDisplayLabelForLocale(tool: string | null | undefined, locale: Locale): string {
  const normalizedTool = normalizeToolName(tool);
  const map: Record<string, MessageKey> = {
    web_search: "tool.display.web_search",
    web_fetch: "tool.display.web_fetch",
    search: "tool.display.search",
    shell_exec: "tool.display.shell_exec",
    file_read: "tool.display.file_read",
    file_write: "tool.display.file_write",
    file_list: "tool.display.file_list",
    vision: "tool.display.vision",
    browser_navigate: "tool.display.browser_navigate",
    browser_click: "tool.display.browser_click",
    browser_extract: "tool.display.browser_extract",
    browser_open: "tool.display.browser_open",
    browser_screenshot: "tool.display.browser_screenshot",
    memory_search: "tool.display.memory_search",
    memory_store: "tool.display.memory_store",
    recall: "tool.display.memory_search",
    remember: "tool.display.memory_store",
    use_skill: "tool.display.use_skill",
  };
  return map[normalizedTool]
    ? translateMessage(locale, map[normalizedTool])
    : normalizedTool.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function isSkillActivationTool(tool?: string | null): boolean {
  return normalizeToolName(tool).toLowerCase() === "use_skill";
}

function cleanSkillName(value?: string | null): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
  return cleaned ? trimMiddle(cleaned, 64) : null;
}

function cleanSkillDescription(value?: string | null): string | null {
  const cleaned = value?.replace(/\s+/g, " ").trim();
  return cleaned ? trimMiddle(cleaned, 160) : null;
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function normalizeSkillLoadOutcome(value?: string | null): SkillLoadOutcome | null {
  if (value === "success" || value === "not_found" || value === "ineligible") return value;
  return null;
}

function skillNameFromActivationText(value?: string | null): string | null {
  const cleaned = cleanSkillName(value);
  if (!cleaned) return null;

  const payload = parseToolPayload(cleaned);
  const structured = cleanSkillName(pickString(payload, ["skillName", "skill_name", "skill", "name"]));
  if (structured) return structured;

  const intentMatch = cleaned.match(/^(?:load|enable|use|activate)\s+skill\s+(.+)$/i);
  return cleanSkillName(intentMatch?.[1] ?? cleaned);
}

export function skillNameForTool(tool: ToolEvent): string | null {
  const runtimeName = cleanSkillName(tool.skillName);
  if (runtimeName) return runtimeName;
  if (!isSkillActivationTool(tool.tool)) return null;
  return skillNameFromActivationText(tool.intent) ?? skillNameFromActivationText(tool.result);
}

function skillDescriptionForTool(tool: ToolEvent): string | null {
  const runtimeDescription = cleanSkillDescription(tool.skillDescription);
  if (runtimeDescription) return runtimeDescription;
  if (!isSkillActivationTool(tool.tool)) return null;
  return cleanSkillDescription(pickString(parseToolPayload(tool.result), ["skillDescription", "skill_description", "description"]));
}

function skillLoadOutcomeForTool(tool: ToolEvent): SkillLoadOutcome | null {
  const runtimeOutcome = normalizeSkillLoadOutcome(tool.skillLoadOutcome);
  if (runtimeOutcome) return runtimeOutcome;
  if (!isSkillActivationTool(tool.tool)) return null;
  const payload = parseToolPayload(tool.result);
  return normalizeSkillLoadOutcome(pickString(payload, ["skillLoadOutcome", "skill_load_outcome", "outcome"]));
}

function skillMissingBinsForTool(tool: ToolEvent): string[] {
  if (tool.skillMissingBins?.length) return tool.skillMissingBins;
  if (!isSkillActivationTool(tool.tool)) return [];
  const payload = parseToolPayload(tool.result);
  return cleanStringList(payload?.skillMissingBins ?? payload?.skill_missing_bins ?? payload?.missingBins ?? payload?.missing_bins);
}

function skillMissingEnvForTool(tool: ToolEvent): string[] {
  if (tool.skillMissingEnv?.length) return tool.skillMissingEnv;
  if (!isSkillActivationTool(tool.tool)) return [];
  const payload = parseToolPayload(tool.result);
  return cleanStringList(payload?.skillMissingEnv ?? payload?.skill_missing_env ?? payload?.missingEnv ?? payload?.missing_env);
}

function skillLoadErrorForTool(tool: ToolEvent): string | null {
  const runtimeError = cleanSkillDescription(tool.skillLoadError);
  if (runtimeError) return runtimeError;
  if (!isSkillActivationTool(tool.tool)) return null;
  const payload = parseToolPayload(tool.result);
  return cleanSkillDescription(pickString(payload, ["skillLoadError", "skill_load_error", "error", "reason"]));
}

function skillActivationLabel(skillName: string | null): string {
  return skillName ? `Skill(${skillName})` : "Skill";
}

function comparableSkillName(value?: string | null): string {
  return cleanSkillName(value)?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
}

function skillSuffixNameForTool(tool: ToolEvent): string | null {
  const skillName = skillNameForTool(tool);
  if (!skillName || isSkillActivationTool(tool.tool)) return null;
  return comparableSkillName(skillName) === comparableSkillName(tool.tool) ? null : skillName;
}

type ToolSemanticKind = "search" | "browser" | "shell" | "write" | "file" | "memory" | "vision" | "skill" | "generic";

function toolSemanticKind(tool?: string | null): ToolSemanticKind {
  const normalized = normalizeToolName(tool).toLowerCase();
  if (isSkillActivationTool(normalized)) return "skill";
  if (normalized.includes("search") || normalized.includes("web")) return "search";
  if (normalized.includes("browser") || normalized.includes("screenshot")) return "browser";
  if (normalized.includes("shell") || normalized.includes("exec")) return "shell";
  if (normalized.includes("write")) return "write";
  if (normalized.includes("file") || normalized.includes("read") || normalized.includes("list")) return "file";
  if (normalized.includes("memory")) return "memory";
  if (normalized.includes("vision")) return "vision";
  return "generic";
}

function toolStepKind(tool?: string | null): ToolStepKind {
  const normalized = normalizeToolName(tool).toLowerCase();
  if (isSkillActivationTool(normalized)) return "skill";
  // create_artifact authors a document — it is a write, never a raw tool
  // name leaking into the narrative tier ("处理 create_artifact").
  if (normalized.includes("write") || normalized.includes("save") || normalized.includes("patch") || normalized.includes("artifact")) return "write";
  if (normalized.includes("shell") || normalized.includes("exec") || normalized.includes("terminal")) return "shell";
  if (
    normalized.includes("fetch") ||
    normalized.includes("read") ||
    normalized.includes("extract") ||
    normalized.includes("open") ||
    normalized.includes("navigate") ||
    normalized.includes("browser")
  ) {
    return "read";
  }
  if (normalized.includes("search") || normalized.includes("query")) return "search";
  if (normalized.includes("list") || normalized.includes("file") || normalized.includes("inspect")) return "inspect";
  return "generic";
}

function parseToolPayload(value?: string): Record<string, unknown> | null {
  const trimmed = value?.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function pickString(payload: Record<string, unknown> | null, keys: string[]): string | null {
  if (!payload) return null;
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).join(" ");
      if (joined.trim()) return joined.trim();
    }
  }
  return null;
}

function trimMiddle(value: string, max = 72): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  const head = Math.max(16, Math.floor(max * 0.62));
  const tail = Math.max(8, max - head - 1);
  return `${normalized.slice(0, head).trim()}…${normalized.slice(-tail).trim()}`;
}

function stripShellNoise(command: string): string {
  return command
    .replace(/\s+/g, " ")
    .replace(/^\/bin\/(?:zsh|bash|sh)\s+-lc\s+/i, "")
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function filenameFromText(value?: string | null): string | null {
  const cleaned = value?.trim();
  if (!cleaned) return null;
  const payload = parseToolPayload(cleaned);
  const structured = pickString(payload, ["filename", "file", "path", "target", "name"]);
  const source = structured ?? cleaned;
  const match = source.match(/(?:^|\s)([./~\w-][^\s"'`]+(?:\.[A-Za-z0-9]{1,8}))/);
  const candidate = (match?.[1] ?? source).replace(/[,:;]+$/g, "");
  const parts = candidate.split(/[\\/]/).filter(Boolean);
  return trimMiddle(parts.at(-1) ?? candidate, 44);
}

function normalizedSourceUrl(...values: Array<string | undefined>): string | null {
  const joined = values.filter(Boolean).join(" ");
  const match = joined.match(/https?:\/\/[^\s<>"'`)\]]+/i);
  if (!match) return null;

  const raw = match[0].replace(/[),.;]+$/g, "");
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return raw.replace(/\/$/, "");
  }
}

function hostnameFromUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    const match = url.match(/^https?:\/\/([^/?#]+)/i);
    return match ? match[1].replace(/^www\./i, "") : null;
  }
}

function normalizedHostnameValue(value: string): string {
  const cleaned = value.trim().replace(/[),.;]+$/g, "");
  try {
    return new URL(cleaned).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return cleaned
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/.*$/g, "")
      .toLowerCase();
  }
}

function isHostnameOnlyTarget(target: string | null, hostname: string | null): boolean {
  if (!target || !hostname) return false;
  return normalizedHostnameValue(target) === normalizedHostnameValue(hostname);
}

function labelContainsHostname(label: string, hostname: string | null): boolean {
  if (!hostname) return false;
  return label.toLowerCase().includes(normalizedHostnameValue(hostname));
}

function pageTitleFromText(value?: string | null): string | null {
  if (!value) return null;
  const titleMatch = value.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch?.[1]?.trim()) return trimMiddle(titleMatch[1], 56);
  const markdownTitle = value.match(/(?:^|\n)\s*#\s+(.+?)\s*(?:\n|$)/);
  if (markdownTitle?.[1]?.trim()) return trimMiddle(markdownTitle[1], 56);
  return null;
}

function queryFromText(value?: string | null): string | null {
  const cleaned = sanitizeToolIntent(value ?? undefined);
  if (!cleaned) return null;
  const payload = parseToolPayload(cleaned);
  const structured = pickString(payload, ["query", "q", "search", "term", "input", "prompt"]);
  const source = structured ?? cleaned;
  if (normalizedSourceUrl(source)) return null;
  return trimMiddle(source.replace(/^(search|query)\s*[:=-]\s*/i, ""), 72);
}

function commandFromText(value?: string | null): string | null {
  const cleaned = sanitizeToolIntent(value ?? undefined);
  if (!cleaned) return null;
  const payload = parseToolPayload(cleaned);
  const structured = pickString(payload, ["command", "cmd", "script", "input"]);
  return trimMiddle(stripShellNoise(structured ?? cleaned), 72);
}

/**
 * Extract a local file name from a tool intent — including structured JSON
 * intents ({"path": "/x/y.json"}), which the leading-char heuristic missed and
 * left rows with the bare "Inspect files" fallback. Returns null unless a real
 * path-like value is found, so free text never becomes a fake filename.
 */
function localFilenameFromIntent(value?: string | null): string | null {
  const cleaned = sanitizeToolIntent(value ?? undefined);
  if (!cleaned) return null;
  const payload = parseToolPayload(cleaned);
  const structured = pickString(payload, ["path", "file", "filename", "target", "name"]);
  const source = structured ?? cleaned;
  const match = source.match(/(?:^|\s)([./~\w-][^\s"'`]+(?:\.[A-Za-z0-9]{1,8}))(?=[\s"'`,)\]]|$)/);
  if (!match && !structured) return null;
  const candidate = (match?.[1] ?? structured ?? "").replace(/[,:;]+$/g, "");
  if (!candidate) return null;
  const parts = candidate.split(/[\\/]/).filter(Boolean);
  return trimMiddle(parts.at(-1) ?? candidate, 44);
}

function targetForToolStep(tool: ToolEvent, kind: ToolStepKind): { target: string | null; url: string | null; hostname: string | null; raw: string | null } {
  const raw = sanitizeToolIntent(tool.intent) ?? sanitizeToolIntent(tool.result) ?? null;
  const url = normalizedSourceUrl(tool.intent, tool.result);
  const hostname = hostnameFromUrl(url);

  if (kind === "search") {
    const query = queryFromText(tool.intent) ?? queryFromText(tool.result);
    return { target: query, url, hostname, raw };
  }

  if (kind === "read") {
    const title = pageTitleFromText(tool.result) ?? pageTitleFromText(tool.intent);
    // Local file reads show the file name, never the full absolute path —
    // paths are technical detail (Issue #635 layer rules). Applies to
    // structured JSON intents too, not only bare leading-slash paths.
    const localFile = url ? null : localFilenameFromIntent(tool.intent);
    return { target: title ?? localFile ?? hostname ?? queryFromText(tool.intent) ?? queryFromText(tool.result), url, hostname, raw };
  }

  if (kind === "shell") {
    return { target: commandFromText(tool.intent) ?? commandFromText(tool.result), url: null, hostname: null, raw };
  }

  if (kind === "write") {
    return { target: filenameFromText(tool.intent) ?? filenameFromText(tool.result), url: null, hostname: null, raw };
  }

  if (kind === "inspect") {
    return { target: localFilenameFromIntent(tool.intent) ?? filenameFromText(tool.result), url, hostname, raw };
  }

  return { target: queryFromText(tool.intent) ?? filenameFromText(tool.intent) ?? hostname, url, hostname, raw };
}

/**
 * Project a tool event's web sources for the source-list UI. Prefers the
 * structured `sources` payload from the runtime; for read-kind steps without
 * one (older sessions), falls back to the single URL the step touched so the
 * narrative layer still has something truthful to show.
 */
function sourcesForToolStep(tool: ToolEvent, kind: ToolStepKind, url: string | null, target: string | null): ExecutionSourceRef[] {
  const structured = Array.isArray(tool.sources) ? tool.sources : [];
  const refs: ExecutionSourceRef[] = [];
  const seen = new Set<string>();
  for (const source of structured) {
    // Rendered as an <a href> — only web URLs may pass, whatever an older
    // session or a hostile provider persisted (matches markdown-link.tsx).
    if (!source || typeof source.url !== "string" || !/^https?:\/\//i.test(source.url)) continue;
    if (seen.has(source.url)) continue;
    seen.add(source.url);
    refs.push({
      title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : null,
      url: source.url,
      snippet: typeof source.snippet === "string" && source.snippet.trim() ? source.snippet.trim() : null,
      hostname: hostnameFromUrl(source.url),
    });
  }
  if (refs.length === 0 && kind === "read" && url) {
    refs.push({ title: target && target !== hostnameFromUrl(url) ? target : null, url, snippet: null, hostname: hostnameFromUrl(url) });
  }
  return refs;
}

export function buildToolStepSummary(tool: ToolEvent, locale: Locale = DEFAULT_LOCALE): ToolStepSummary {
  const kind = toolStepKind(tool.tool);
  const skillName = skillNameForTool(tool);
  const skillDescription = skillDescriptionForTool(tool);
  const skillLoadOutcome = skillLoadOutcomeForTool(tool);
  const skillMissingBins = skillMissingBinsForTool(tool);
  const skillMissingEnv = skillMissingEnvForTool(tool);
  const skillLoadError = skillLoadErrorForTool(tool);
  const skillSuffixName = skillSuffixNameForTool(tool);
  const isSkillActivation = isSkillActivationTool(tool.tool);

  if (isSkillActivation) {
    const label = skillActivationLabel(skillName);
    return {
      kind,
      label,
      timelineLabel: label,
      target: skillName,
      url: null,
      hostname: null,
      showHostnameChip: false,
      raw: sanitizeToolIntent(tool.intent) ?? null,
      skillName,
      skillDescription,
      skillLoadOutcome,
      skillMissingBins,
      skillMissingEnv,
      skillLoadError,
      skillSuffixName: null,
      isSkillActivation: true,
      sources: [],
    };
  }

  const { target, url, hostname, raw } = targetForToolStep(tool, kind);
  // Public copy calls shell work "Run"; the internal semantic kind is
  // "shell". Keep that mapping explicit so raw i18n keys never leak into UI.
  const copyKind = kind === "shell" ? "run" : kind;
  const fallbackKey = `execution.step.${copyKind}Fallback` as MessageKey;
  const templateKey = `execution.step.${copyKind}` as MessageKey;
  const safeTarget = target || translateMessage(locale, fallbackKey);
  const label = translateMessage(locale, templateKey, { target: safeTarget });
  const targetIsHostname = isHostnameOnlyTarget(target, hostname);
  const timelineLabel = targetIsHostname
    ? translateMessage(locale, templateKey, { target: "" }).trim() || label
    : label;
  return {
    kind,
    label,
    timelineLabel,
    target,
    url,
    hostname,
    showHostnameChip: Boolean(url && hostname && (targetIsHostname || !labelContainsHostname(label, hostname))),
    raw,
    skillName,
    skillDescription,
    skillLoadOutcome,
    skillMissingBins,
    skillMissingEnv,
    skillLoadError,
    skillSuffixName,
    isSkillActivation,
    sources: sourcesForToolStep(tool, kind, url, target),
  };
}

function toolSourceKey(tool: ToolEvent): string | null {
  const semantic = toolSemanticKind(tool.tool);
  if (semantic !== "search" && semantic !== "browser") return null;

  const url = normalizedSourceUrl(tool.intent, tool.result, tool.error);
  if (!url) return null;
  return `${semantic}:${url}`;
}

export function compactToolEventsForUser(tools: ToolEvent[]): ToolEvent[] {
  const latestByCall = new Map<string, ToolEvent>();
  tools.forEach((tool, index) => {
    const key = tool.callId || `${tool.id}-${index}`;
    const existing = latestByCall.get(key);
    if (!existing || tool.phase === "end" || tool.timestamp > existing.timestamp) {
      latestByCall.set(key, tool);
    }
  });

  const passthrough: ToolEvent[] = [];
  const bySource = new Map<string, { success?: ToolEvent; running?: ToolEvent; error?: ToolEvent }>();

  for (const tool of latestByCall.values()) {
    const key = toolSourceKey(tool);
    if (!key) {
      passthrough.push(tool);
      continue;
    }

    const entry = bySource.get(key) ?? {};
    const state = getToolState(tool);
    if (state === "success" && (!entry.success || tool.timestamp >= entry.success.timestamp)) {
      entry.success = tool;
    } else if (state === "running" && (!entry.running || tool.timestamp >= entry.running.timestamp)) {
      entry.running = tool;
    } else if (state === "error" && (!entry.error || tool.timestamp >= entry.error.timestamp)) {
      entry.error = tool;
    }
    bySource.set(key, entry);
  }

  const compactedSources = [...bySource.values()]
    .map((entry) => entry.success ?? entry.running ?? entry.error)
    .filter((tool): tool is ToolEvent => Boolean(tool));

  return [...passthrough, ...compactedSources].sort((a, b) => a.timestamp - b.timestamp);
}

function toolKindLabel(locale: Locale, prefix: "tool.user" | "tool.running" | "tool.done", tool?: string | null): string {
  return translateMessage(locale, `${prefix}.${toolSemanticKind(tool)}` as MessageKey);
}

export function toolUserActionLabel(tool?: string | null, locale: Locale = DEFAULT_LOCALE): string {
  return toolKindLabel(locale, "tool.user", tool);
}

export function toolRunningActionLabel(tool?: string | null, locale: Locale = DEFAULT_LOCALE, skillName?: string | null): string {
  // The skill NAME is runtime truth the user asked to see (operator,
  // 2026-07-18) — "Loading skill research-workflow", not a nameless
  // "Loading skill".
  const label = toolKindLabel(locale, "tool.running", tool);
  return skillName ? `${label} ${skillName}` : label;
}

export function toolDoneActionLabel(tool?: string | null, locale: Locale = DEFAULT_LOCALE): string {
  return toolKindLabel(locale, "tool.done", tool);
}

export function toolActionLabel(tool?: string | null, locale: Locale = DEFAULT_LOCALE): string {
  return toolUserActionLabel(tool, locale);
}

function countToolCalls(tools: ToolEvent[]): number {
  const callIds = new Set<string>();
  let anonymous = 0;
  for (const tool of tools) {
    if (tool.callId) {
      callIds.add(tool.callId);
    } else {
      anonymous += 1;
    }
  }
  return callIds.size + anonymous;
}

export function buildExecutionBlockModel(
  items: TimelineItem[],
  fallbackKey: string,
  locale?: Locale,
): ExecutionBlockModel {
  const tasks = items
    .filter((item): item is TimelineItem & { data: TaskUpdate } => item.type === "task_update")
    .map((item) => item.data);
  const rawTools = items
    .filter((item): item is TimelineItem & { data: ToolEvent } => item.type === "tool_event")
    .map((item) => item.data);
  const tools = compactToolEventsForUser(rawTools);
  const plan = items.findLast((item) => item.type === "plan_started")?.data as PlanStartedUpdate | undefined;

  const status = getExecutionState(tasks, tools);
  const turnId = items.map(getExecutionTurnId).find(Boolean);
  const failedTaskCount = tasks.filter((task) => task.status === "failed" && !isCancelledTask(task)).length;
  const toolErrorCount = tools.filter((tool) => getToolState(tool) === "error" && !isBenignToolFailure(tool)).length;
  // PLAN-backed turns count only failed TASKS as issues: a tool error inside a
  // step the runner retried past is internal recovery, not something the user
  // must attend to (real case: 5/5 steps green + 1 failed verification row
  // summarized as "Needs attention (15)" because 14 recovered web_fetch 502s
  // were tallied in). A step that failed BECAUSE of tool errors already counts
  // once via its task row.
  //
  // Plan-backed means: a plan_started row in THIS block, OR the block executes
  // under a `turn_bg_<planId>` turn — the runner's stable id contract
  // (planBackgroundTurnId). The turn-id check is required because the typed
  // plan lives on the FOREGROUND turn and the projection only forwards it onto
  // the bg block AFTER this model is built (live-verified: the restored bg
  // block read "(9)" = 1 failed task + 8 windowed tool errors without it).
  //
  // NOT `tasks.length > 0`: plan-less turns also carry task rows (dag_created
  // handoffs, delegated-task lifecycle rows), and a completed handoff row must
  // not suppress a genuine tool failure on the same turn (HIGH-2 review
  // finding) — those turns keep the original tasks-plus-tools tally.
  const planBacked = !!plan || (turnId?.startsWith("turn_bg_") ?? false);
  const issueCount = planBacked ? failedTaskCount : failedTaskCount + toolErrorCount;
  const totalElapsedMs =
    tools.reduce((sum, tool) => sum + (tool.elapsed_ms ?? 0), 0) +
    tasks.reduce((sum, task) => sum + (task.elapsed_ms ?? 0), 0);
  const issueSummaries = buildExecutionIssueSummaries(tasks, tools);
  // The typed plan event carries its own presentation locale (resolved at
  // admission, dag-bridge) — when the caller has none (bg envelope not yet
  // stamped, legacy rows), the plan's language beats the UI language so the
  // card never mixes 任务计划 chrome with English phases.
  const planLocale = plan?.locale === "en" || plan?.locale === "zh-CN" ? plan.locale : undefined;

  return {
    key: turnId ? `${turnId}-${fallbackKey}` : fallbackKey,
    turnId,
    locale: locale ?? planLocale,
    headline: getHeadline(tasks, tools, status),
    status,
    toolCount: countToolCalls(tools),
    taskCount: tasks.length,
    issueCount,
    totalElapsedMs,
    issueSummaries,
    tasks,
    tools,
    plan,
  };
}

export function buildChatRenderItems(timeline: TimelineItem[]): ChatRenderItem[] {
  const renderItems: ChatRenderItem[] = [];
  const artifactCoveredTurnIds = getArtifactCoveredTurnIds(timeline);
  const concreteExecutionTurnIds = getConcreteExecutionTurnIds(timeline);
  const conversationSegments = getTimelineConversationSegments(timeline);
  const conversationLocales = getTimelineConversationLocales(timeline);
  const concreteExecutionSegments = getConcreteExecutionSegments(timeline, conversationSegments);
  let executionItems: TimelineItem[] = [];
  let executionMeta: { turnId?: string; taskIds: Set<string>; startIndex: number; segment: number; locale?: Locale } | null = null;

  const flushExecutionItems = (nextItem?: TimelineItem | null) => {
    if (executionItems.length === 0 || !executionMeta) return;
    const block = buildExecutionBlockModel(executionItems, `execution-${executionMeta.startIndex}`, executionMeta.locale);
    const previousItem = getLatestRenderedSingleItem(renderItems);
    const duplicateLifecycleInCurrentUserTurn =
      executionMeta.segment >= 0 &&
      concreteExecutionSegments.has(executionMeta.segment) &&
      isNoisyLifecycleOnlyBlock(block);
    if (
      (block.turnId && artifactCoveredTurnIds.has(block.turnId) && block.issueCount === 0) ||
      (block.turnId && concreteExecutionTurnIds.has(block.turnId) && isNoisyLifecycleOnlyBlock(block)) ||
      duplicateLifecycleInCurrentUserTurn ||
      !shouldRenderExecutionBlock(block, nextItem, previousItem)
    ) {
      executionItems = [];
      executionMeta = null;
      return;
    }
    renderItems.push({
      kind: "execution",
      block,
    });
    executionItems = [];
    executionMeta = null;
  };

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    if (!isExecutionTimelineItem(item)) {
      flushExecutionItems(item);
      renderItems.push({ kind: "single", item, index: i });
      continue;
    }

    if (!executionMeta) {
      const taskIds = new Set<string>();
      const taskId = getExecutionTaskId(item);
      if (taskId) taskIds.add(taskId);
      executionMeta = {
        turnId: getExecutionTurnId(item),
        taskIds,
        startIndex: i,
        segment: conversationSegments[i] ?? -1,
        locale: conversationLocales[i],
      };
      executionItems.push(item);
      continue;
    }

    if (!canAppendToExecutionBlock({ ...executionMeta, items: executionItems }, item)) {
      flushExecutionItems(item);
      const taskIds = new Set<string>();
      const taskId = getExecutionTaskId(item);
      if (taskId) taskIds.add(taskId);
      executionMeta = {
        turnId: getExecutionTurnId(item),
        taskIds,
        startIndex: i,
        segment: conversationSegments[i] ?? -1,
        locale: conversationLocales[i],
      };
      executionItems.push(item);
      continue;
    }

    const taskId = getExecutionTaskId(item);
    if (taskId) executionMeta.taskIds.add(taskId);
    if (!executionMeta.turnId) executionMeta.turnId = getExecutionTurnId(item);
    executionItems.push(item);
  }

  flushExecutionItems();
  return normalizeTurnDisplayOrder(renderItems);
}

function normalizeTurnDisplayOrder(items: ChatRenderItem[]): ChatRenderItem[] {
  const ordered: ChatRenderItem[] = [];

  for (let start = 0; start < items.length;) {
    let end = start + 1;
    while (end < items.length && !isUserRenderItem(items[end])) end += 1;

    const segment = items.slice(start, end);
    const lastAssistantIndex = segment.findLastIndex(isAssistantRenderItem);
    if (lastAssistantIndex < 0) {
      ordered.push(...segment);
      start = end;
      continue;
    }

    // Only deliverable artifacts move after the answer. Failed/mixed blocks
    // stay in place: once a later answer exists they are survived process and
    // belong inside the turn fold, not re-surfaced below the answer.
    const moveAfterAnswer = segment.filter((item, index) => (
      index < lastAssistantIndex && item.kind === "single" && item.item.type === "artifact"
    ));
    if (moveAfterAnswer.length === 0) {
      ordered.push(...segment);
      start = end;
      continue;
    }

    const moved = new Set(moveAfterAnswer);
    segment.forEach((item, index) => {
      if (!moved.has(item)) ordered.push(item);
      if (index === lastAssistantIndex) ordered.push(...moveAfterAnswer);
    });
    start = end;
  }

  return ordered;
}

function isUserRenderItem(item: ChatRenderItem): boolean {
  return item.kind === "single" && item.item.type === "message" && (item.item.data as ChatMessage).role === "user";
}

function isAssistantRenderItem(item: ChatRenderItem): boolean {
  return item.kind === "single" && item.item.type === "message" && (item.item.data as ChatMessage).role === "assistant";
}
