import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  FileOutput,
  GripVertical,
  ListTree,
  Maximize2,
  Minimize2,
  RefreshCw,
  Sparkles,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type {
  Artifact,
  PlanStartedUpdate,
  SessionRunDetail,
  TaskUpdate,
  TimelineItem,
  ToolEvent,
  TurnEnvelope,
} from "@/types";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { translateMessage, useLocale, type MessageKey } from "@/i18n";
import { compactIssueDetail, toolDisplayLabelForLocale } from "./execution";
import DagView from "./DagView";
import { mergeRunTimeline, projectRunPresentation, timelineItemTurnId } from "./run-metrics";
import RunOverview from "./RunOverview";
import RunReasoning from "./RunReasoning";
import RunTrace, { type RunTraceRow } from "./RunTrace";
import RunOutputs from "./RunOutputs";

export type RunTab = "overview" | "plan" | "reasoning" | "trace" | "outputs";

interface RunInspectorProps {
  sessionId: string;
  turnId: string;
  liveTimeline?: TimelineItem[];
  liveTurns?: TurnEnvelope[];
  width?: number;
  fullscreen: boolean;
  docked: boolean;
  onResize: (width: number) => number | void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  onFullscreenChange: (fullscreen: boolean) => void;
  onClose: () => void;
  onBack?: () => void;
  onOpenArtifact: (artifact: Artifact) => void;
  initialTab?: RunTab;
  onTabChange?: (tab: RunTab) => void;
}

const TABS: Array<{ id: RunTab; label: MessageKey; Icon: LucideIcon }> = [
  { id: "overview", label: "run.tab.overview", Icon: Activity },
  { id: "plan", label: "run.tab.plan", Icon: ListTree },
  { id: "reasoning", label: "run.tab.reasoning", Icon: Sparkles },
  { id: "trace", label: "run.tab.trace", Icon: Wrench },
  { id: "outputs", label: "run.tab.outputs", Icon: FileOutput },
];

function runOutcome(turns: TurnEnvelope[]): TurnEnvelope["outcome"] | undefined {
  if (turns.some((turn) => turn.status === "active" || turn.status === "awaiting_approval")) return undefined;
  return turns
    .filter((turn) => Boolean(turn.outcome))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]?.outcome;
}

function traceRows(
  timeline: TimelineItem[],
  tasks: TaskUpdate[],
  unresolvedIds: ReadonlySet<string>,
  locale: "en" | "zh-CN",
): RunTraceRow[] {
  const rows: RunTraceRow[] = [];
  const starts = new Map<string, ToolEvent>();
  for (const item of timeline) {
    if (item.type === "tool_event") {
      const tool = item.data as ToolEvent;
      if (tool.phase === "start") {
        starts.set(tool.callId, tool);
        continue;
      }
      const start = starts.get(tool.callId);
      starts.delete(tool.callId);
      const unresolved = unresolvedIds.has(tool.callId) || unresolvedIds.has(tool.id);
      // Attempt-level failures are implementation history, even when another
      // part of the run ultimately fails. Only an exact terminal outcome
      // source is promoted into the user-facing trace.
      if (tool.status === "error" && !unresolved) continue;
      const detail = tool.status === "error"
        ? compactIssueDetail(tool.error || tool.result || "")
        : (tool.intent || start?.intent || undefined);
      rows.push({
        key: `tool:${tool.callId}`,
        timestamp: start?.timestamp ?? tool.timestamp,
        title: toolDisplayLabelForLocale(tool.tool, locale),
        detail,
        state: tool.status === "error" ? "failed" : "completed",
        durationMs: tool.elapsed_ms ?? (start ? Math.max(0, tool.timestamp - start.timestamp) : undefined),
      });
      continue;
    }
  }
  for (const task of tasks) {
    if (task.status !== "completed" && task.status !== "failed") continue;
    const unresolved = unresolvedIds.has(task.task_id) || unresolvedIds.has(task.id);
    if (task.status === "failed" && !unresolved) continue;
    rows.push({
      key: `task:${task.task_id}`,
      timestamp: task.timestamp,
      title: task.title,
      detail: task.status === "failed" ? compactIssueDetail(task.detail || task.rawStatus || "") : undefined,
      state: task.status === "failed" ? "failed" : "completed",
      durationMs: task.elapsed_ms,
    });
  }
  for (const tool of starts.values()) {
    rows.push({
      key: `tool:${tool.callId}:start`,
      timestamp: tool.timestamp,
      title: toolDisplayLabelForLocale(tool.tool, locale),
      detail: tool.intent,
      state: "started",
    });
  }
  return rows.sort((a, b) => a.timestamp - b.timestamp);
}

function PanelSkeleton() {
  return (
    <div data-testid="run-inspector-loading" className="space-y-4 p-5" aria-busy="true">
      <div className="h-24 animate-pulse rounded-lg bg-ink/[0.035]" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-ink/[0.035]" />
      <div className="h-4 w-1/2 animate-pulse rounded bg-ink/[0.035]" />
    </div>
  );
}

export default function RunInspector({
  sessionId,
  turnId,
  liveTimeline = [],
  liveTurns = [],
  width,
  fullscreen,
  docked,
  onResize,
  onResizeStart,
  onResizeEnd,
  onFullscreenChange,
  onClose,
  onBack,
  onOpenArtifact,
  initialTab = "overview",
  onTabChange,
}: RunInspectorProps) {
  const { get } = useApi();
  const { locale, t } = useLocale();
  const [detail, setDetail] = useState<SessionRunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryEpoch, setRetryEpoch] = useState(0);
  const [activeTab, setActiveTab] = useState<RunTab>(initialTab);
  const [now, setNow] = useState(() => Date.now());
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const resizeHandleRef = useRef<HTMLButtonElement | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;
  const canResize = docked && !fullscreen && typeof width === "number";

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    void get<SessionRunDetail>(`/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(turnId)}`).then((result) => {
      if (cancelled) return;
      if (result.error || !result.data) {
        setError(result.error || t("run.inspector.loadFailed"));
        return;
      }
      setDetail(result.data);
    });
    return () => { cancelled = true; };
  }, [get, retryEpoch, sessionId, t, turnId]);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab, sessionId, turnId]);

  const currentDetail = detail?.sessionId === sessionId && detail.runId === turnId ? detail : null;

  const liveDetail = useMemo(() => {
    if (!currentDetail) return null;
    const claimed = new Set(currentDetail.claimedTurnIds);
    claimed.add(turnId);
    // Link an admission turn and its background worker even if the Inspector
    // was opened before the background envelope existed in the API snapshot.
    for (const item of [...currentDetail.timeline, ...liveTimeline]) {
      if (item.type !== "plan_started") continue;
      const plan = item.data as PlanStartedUpdate;
      const parent = timelineItemTurnId(item);
      const background = `turn_bg_${plan.plan_id}`;
      if (claimed.has(parent ?? "") || claimed.has(background)) {
        if (parent) claimed.add(parent);
        claimed.add(background);
      }
    }
    const turnMap = new Map(currentDetail.turns.map((turn) => [turn.turnId, turn]));
    for (const turn of liveTurns) {
      if (claimed.has(turn.turnId)) turnMap.set(turn.turnId, turn);
    }
    return {
      ...currentDetail,
      claimedTurnIds: [...claimed],
      turns: [...turnMap.values()].filter((turn) => claimed.has(turn.turnId)),
      timeline: mergeRunTimeline(currentDetail.timeline, liveTimeline, claimed),
    };
  }, [currentDetail, liveTimeline, liveTurns, turnId]);

  const running = Boolean(liveDetail?.turns.some((turn) => turn.status === "active" || turn.status === "awaiting_approval"));
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fullscreen) onFullscreenChange(false);
      else onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, onClose, onFullscreenChange]);

  const stopResize = useCallback(() => {
    const wasDragging = Boolean(dragRef.current);
    dragRef.current = null;
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (wasDragging) onResizeEnd?.();
  }, [onResizeEnd]);

  const onResizeMove = useCallback((event: PointerEvent) => {
    if (!dragRef.current) return;
    const desired = dragRef.current.startWidth + dragRef.current.startX - event.clientX;
    const applied = onResize(desired);
    if (typeof applied === "number" && applied !== desired) {
      dragRef.current = { startX: event.clientX, startWidth: applied };
    }
  }, [onResize]);

  useEffect(() => {
    const handle = resizeHandleRef.current;
    if (!handle || !canResize) return;
    const beginResize = (event: PointerEvent) => {
      event.preventDefault();
      dragRef.current = { startX: event.clientX, startWidth: widthRef.current ?? 0 };
      setResizing(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      onResizeStart?.();
    };
    handle.addEventListener("pointerdown", beginResize);
    return () => handle.removeEventListener("pointerdown", beginResize);
  }, [canResize, onResizeStart]);

  useEffect(() => {
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", onResizeMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      stopResize();
    };
  }, [onResizeMove, stopResize]);

  const model = useMemo(() => {
    if (!liveDetail) return null;
    const outcome = runOutcome(liveDetail.turns);
    const turnIds = new Set(liveDetail.claimedTurnIds);
    const presentation = projectRunPresentation(turnIds, liveDetail.timeline);
    const unresolvedIds = new Set(outcome?.issues.flatMap((issue) => issue.sourceId ? [issue.sourceId] : []) ?? []);
    const starts = liveDetail.turns.map((turn) => turn.startedAt);
    const ends = liveDetail.turns.map((turn) => turn.endedAt).filter((value): value is number => typeof value === "number");
    const effectiveEnd = running ? now : (ends.length > 0 ? Math.max(...ends) : now);
    const duration = starts.length ? Math.max(0, effectiveEnd - Math.min(...starts)) : 0;
    const trace = traceRows(presentation.items, presentation.tasks, unresolvedIds, locale);
    if (starts.length) trace.push({ key: "run:start", timestamp: Math.min(...starts), title: translateMessage(locale, "run.trace.runStarted"), state: "started" });
    if (!running && ends.length && outcome) {
      trace.push({ key: "run:end", timestamp: Math.max(...ends), title: translateMessage(locale, "run.trace.runEnded"), state: "ended", durationMs: duration });
    }
    trace.sort((a, b) => a.timestamp - b.timestamp);
    return { outcome, ...presentation, trace, duration, running };
  }, [liveDetail, locale, now, running]);

  return (
    <aside
      data-testid="run-inspector"
      className={cn(
        "fixed inset-y-0 right-0 z-40 flex flex-col overflow-hidden border-l border-ink/[0.08] bg-elevated/95 shadow-[-20px_0_60px_-15px_rgba(0,0,0,0.5)] backdrop-blur-2xl",
        resizing ? "" : "transition-[inset,width] duration-200",
        fullscreen ? "inset-0 z-[100]" : docked ? "" : "left-0 w-full",
      )}
      style={!fullscreen && docked && width ? { width } : undefined}
      aria-label={t("run.inspector.title")}
    >
      {canResize && (
        <button
          ref={resizeHandleRef}
          type="button"
          data-testid="run-resize-handle"
          aria-label={t("artifact.resizePanel")}
          className="group absolute inset-y-0 left-0 z-10 flex w-3 -translate-x-1/2 cursor-col-resize items-center justify-center"
        >
          <span className="h-full w-px bg-ink/[0.08] transition-colors group-hover:bg-focus/60" />
          <span className="absolute flex h-9 w-4 items-center justify-center rounded-full border border-ink/[0.08] bg-surface/95 text-ink/25 opacity-0 shadow-lg transition-opacity group-hover:opacity-100"><GripVertical size={12} /></span>
        </button>
      )}

      <header className="desktop-window-drag-region flex h-12 shrink-0 items-center gap-2 border-b border-ink/[0.08] px-3">
        {onBack && (
          <button type="button" onClick={onBack} aria-label={t("common.back")} className="rounded-md p-2 text-ink/35 outline-none hover:bg-ink/[0.05] hover:text-ink/60 focus-visible:ring-2 focus-visible:ring-focus/40">
            <ArrowLeft size={15} />
          </button>
        )}
        <Activity size={15} className="text-ink/45" aria-hidden="true" />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/78">{t("run.inspector.title")}</h2>
        <button type="button" onClick={() => onFullscreenChange(!fullscreen)} aria-label={fullscreen ? t("artifact.exitFullscreen") : t("artifact.fullscreen")} className="rounded-md p-2 text-ink/35 outline-none hover:bg-ink/[0.05] hover:text-ink/60 focus-visible:ring-2 focus-visible:ring-focus/40">
          {fullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <button type="button" onClick={onClose} aria-label={t("artifact.closePanel")} className="rounded-md p-2 text-ink/35 outline-none hover:bg-ink/[0.05] hover:text-ink/60 focus-visible:ring-2 focus-visible:ring-focus/40"><X size={15} /></button>
      </header>

      <nav role="tablist" aria-label={t("run.inspector.title")} className="flex shrink-0 gap-1 overflow-x-auto border-b border-ink/[0.08] px-3 py-2">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            onClick={() => {
              setActiveTab(id);
              onTabChange?.(id);
            }}
            className={cn(
              "flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus/40",
              activeTab === id ? "bg-ink/[0.07] text-ink/76" : "text-ink/38 hover:bg-ink/[0.035] hover:text-ink/60",
            )}
          >
            <Icon size={13} aria-hidden="true" />{t(label)}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!currentDetail && !error && <PanelSkeleton />}
        {error && (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertTriangle size={20} className="text-warning" />
            <p className="max-w-sm text-[13px] text-ink/55">{t("run.inspector.loadFailed")}</p>
            <button type="button" onClick={() => setRetryEpoch((value) => value + 1)} className="flex min-h-10 items-center gap-2 rounded-md border border-ink/[0.08] px-3 text-[12px] text-ink/64 outline-none hover:bg-ink/[0.04] focus-visible:ring-2 focus-visible:ring-focus/40"><RefreshCw size={13} />{t("common.retry")}</button>
          </div>
        )}
        {model && activeTab === "overview" && <RunOverview running={model.running} duration={model.duration} metrics={model.metrics} />}
        {model && activeTab === "plan" && (
          <section className="p-5" data-testid="run-tab-plan">
            {model.plan ? <DagView plan={model.plan} tasks={model.tasks} /> : <p className="py-12 text-center text-[12.5px] text-ink/38">{t("run.plan.empty")}</p>}
          </section>
        )}
        {model && activeTab === "reasoning" && <RunReasoning passes={model.reasoning} />}
        {model && activeTab === "trace" && <RunTrace rows={model.trace} />}
        {model && activeTab === "outputs" && <RunOutputs artifacts={model.artifacts} onOpen={onOpenArtifact} />}
      </div>
    </aside>
  );
}
