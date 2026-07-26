/**
 * Everything MOZI runs on a schedule, as one list.
 *
 * This page used to show two unrelated things stacked on each other: cron tasks
 * (read-only — `POST /api/scheduler/tasks` worked but nothing in the UI called
 * it, so a task could only be created by asking the Brain) and reminders (an
 * inline three-field form). Two interaction models, and the more important one
 * had no way in. It now reads `/api/scheduler/items`, which normalises both.
 *
 * Runtime identifiers stay off the card. It used to lead with
 * `cron: 15 15 * * 1-5 · managed_brain` and `Permission level: L3_FULL_ACCESS`
 * — an expression, an internal handler id and an enum, standing in for a
 * description of what the thing actually does.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Bell,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { useApi } from "@/hooks/useApi";
import { useLocale, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import { formatSchedule, scheduleDetail, type ScheduleKind } from "@/lib/schedule-format";
import { ScheduleComposer, emptyDraft, type ScheduleDraft } from "./ScheduleComposer";
import { TemplateGrid } from "./TemplateGrid";

interface SchedulerRun {
  id: string;
  session_id?: string | null;
  scheduled_for: string;
  trigger_origin?: "schedule" | "manual";
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface ScheduledItem {
  id: string;
  kind: "prompt" | "reminder";
  body: string;
  schedule: { kind: ScheduleKind; value: string; timezone?: string | null };
  status: "scheduled" | "running" | "ok" | "failed" | "paused" | "done";
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  runCount: number;
  error?: string | null;
  permissionLevel?: string | null;
  canPause: boolean;
  canRunNow: boolean;
  runs?: SchedulerRun[];
}

const STATUS_LABEL: Record<ScheduledItem["status"], MessageKey> = {
  ok: "scheduled.status.ok",
  failed: "scheduled.status.failed",
  running: "scheduled.status.running",
  paused: "scheduled.status.paused",
  scheduled: "scheduled.status.scheduled",
  done: "scheduled.status.done",
};

const STATUS_DOT: Record<ScheduledItem["status"], string> = {
  ok: "var(--success)",
  failed: "var(--danger)",
  running: "var(--activity)",
  paused: "rgb(var(--ink-rgb) / 0.24)",
  scheduled: "rgb(var(--ink-rgb) / 0.24)",
  done: "rgb(var(--ink-rgb) / 0.24)",
};

function normalizeItems(payload: unknown): ScheduledItem[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  return Array.isArray(record.items) ? (record.items as ScheduledItem[]) : [];
}

/** SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC; Date needs the T and the Z. */
function normalizedDate(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) return `${trimmed.replace(" ", "T")}Z`;
  return trimmed;
}

function formatMoment(value: string | null | undefined, locale: string, fallback = ""): string {
  if (!value) return fallback;
  const parsed = Date.parse(normalizedDate(value));
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(parsed);
}

function runDuration(run: SchedulerRun): { minutes: number; seconds: number } | null {
  if (!run.started_at || !run.completed_at) return null;
  const elapsed = Date.parse(normalizedDate(run.completed_at)) - Date.parse(normalizedDate(run.started_at));
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const totalSeconds = Math.floor(elapsed / 1000);
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

function ItemRow({
  item,
  locale,
  busy,
  onDelete,
  onToggle,
  onRunNow,
  onOpenSession,
}: {
  item: ScheduledItem;
  locale: string;
  busy: boolean;
  onDelete: (item: ScheduledItem) => void;
  onToggle: (item: ScheduledItem) => void;
  onRunNow: (item: ScheduledItem) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useLocale();
  const [showRuns, setShowRuns] = useState(false);
  const translate = t as (key: string, vars?: Record<string, unknown>) => string;

  const paused = item.status === "paused";
  const readableSchedule = formatSchedule(item.schedule, locale, translate);
  const expression = scheduleDetail(item.schedule, locale, translate);
  const activeRun = item.runs?.find(run => run.status === "running" || run.status === "queued");

  return (
    <article className="border-b border-ink/[0.045] px-3 py-3 last:border-b-0">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(150px,200px)_auto] md:items-start">
        <div className="flex min-w-0 items-start gap-2">
          {item.kind === "reminder"
            ? <Bell className="mt-0.5 h-4 w-4 shrink-0 text-ink/38" strokeWidth={1.75} />
            : <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-ink/38" strokeWidth={1.75} />}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[13.5px] font-medium text-ink/82">{item.body}</h2>
              {paused && <span className="shrink-0 text-[11px] text-warning">{t("scheduled.paused")}</span>}
            </div>
            <p className="mt-0.5 truncate text-[11.5px] text-ink/45" title={expression ?? undefined}>
              {readableSchedule}
              {item.permissionLevel && <span className="text-ink/30"> · {item.permissionLevel}</span>}
            </p>
          </div>
        </div>

        <div className="min-w-0">
          <div className="text-[10.5px] uppercase text-ink/28">{t("scheduled.nextRun")}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink/62">
            {paused ? "" : formatMoment(item.nextRunAt, locale, t("scheduled.noNextRun"))}
          </div>
          {activeRun?.session_id && onOpenSession ? (
            <button
              type="button"
              onClick={() => onOpenSession(activeRun.session_id!)}
              className="mt-1 flex items-center gap-1.5 text-[12px] text-activity underline underline-offset-2"
            >
              <span data-testid={`task-status-dot-${item.id}`} className="h-2 w-2 rounded-full bg-activity pulse-dot" />
              {t("scheduler.running_view_live")}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-ink/50">
              <span
                data-testid={`task-status-dot-${item.id}`}
                className="h-2 w-2 rounded-full"
                style={{ background: STATUS_DOT[item.status] }}
              />
              {t(STATUS_LABEL[item.status])}
            </div>
          )}
        </div>

        <div className="flex items-center gap-1">
          {item.canRunNow && (
            <button
              type="button"
              onClick={() => onRunNow(item)}
              disabled={busy || !!activeRun}
              title={t("scheduler.task_run_now")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink/45 transition-colors hover:text-ink/72 disabled:opacity-30"
            >
              <CirclePlay className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
          {item.canPause && (
            <button
              type="button"
              onClick={() => onToggle(item)}
              disabled={busy}
              title={paused ? t("scheduler.task_resume") : t("scheduler.task_pause")}
              className="flex h-7 w-7 items-center justify-center rounded-md text-ink/45 transition-colors hover:text-ink/72 disabled:opacity-30"
            >
              {paused ? <Play className="h-4 w-4" strokeWidth={1.75} /> : <Pause className="h-4 w-4" strokeWidth={1.75} />}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(item)}
            disabled={busy}
            title={t("scheduler.task_delete")}
            className="flex h-7 w-7 items-center justify-center rounded-md text-ink/45 transition-colors hover:text-danger disabled:opacity-30"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" strokeWidth={1.75} />}
          </button>
        </div>
      </div>

      {/* A failure used to be a red dot whose reason sat inside a <summary> with
          its disclosure marker removed — the text was rendered and invisible.
          It states itself now. */}
      {item.status === "failed" && item.error && (
        <div className="mt-2 flex items-start gap-2 rounded-md bg-danger/10 px-2.5 py-2 text-[11.5px] leading-4 text-danger">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
          <div className="min-w-0">
            <div className="font-medium">{t("scheduled.failedLabel")}</div>
            <p className="mt-0.5 overflow-wrap-anywhere opacity-90">{item.error}</p>
          </div>
        </div>
      )}

      {item.runs && item.runs.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowRuns(value => !value)}
            className="flex items-center gap-1 text-[11.5px] text-ink/38 transition-colors hover:text-ink/62"
          >
            <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showRuns ? "" : "-rotate-90")} />
            {t("scheduler.run_history")}
          </button>
          {showRuns && (
            <ul className="mt-1.5 flex flex-col gap-1">
              {item.runs.map(run => {
                const duration = runDuration(run);
                const durationLabel = run.status.toLowerCase() === "running"
                  ? t("scheduler.run_in_progress")
                  : duration
                    ? duration.minutes > 0
                      ? t("scheduler.run_duration_minutes", duration)
                      : t("scheduler.run_duration_seconds", duration)
                    : "—";
                return (
                  <li key={run.id} className="flex flex-wrap items-center gap-2 text-[11.5px] text-ink/45">
                    <span>{formatMoment(run.started_at ?? run.scheduled_for, locale, "—")}</span>
                    <span className="text-ink/28">
                      {run.trigger_origin === "manual" ? t("scheduler.run_origin_manual") : t("scheduler.run_origin_schedule")}
                    </span>
                    <span className="text-ink/38">{run.status}</span>
                    <span className="text-ink/28">{durationLabel}</span>
                    {run.session_id && onOpenSession && (
                      <button
                        type="button"
                        onClick={() => onOpenSession(run.session_id!)}
                        className="text-link underline underline-offset-2"
                      >
                        {t("scheduler.view_live_run")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

export default function ScheduledView({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const { locale, t } = useLocale();
  const { get, post, patch, del } = useApi();
  const [items, setItems] = useState<ScheduledItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await get<unknown>("/api/scheduler/items");
    if (result.error) {
      setItems([]);
      setError(result.error);
    } else {
      setItems(normalizeItems(result.data));
    }
    setLoading(false);
  }, [get]);

  useEffect(() => { void load(); }, [load]);

  // A scheduled prompt captures the session's permission level. Showing the one
  // already in force keeps that from being a silent inherit — which is how a
  // task ended up running unattended at L3_FULL_ACCESS.
  const inheritedPermission = useMemo(
    () => items.find(item => item.kind === "prompt" && item.permissionLevel)?.permissionLevel ?? null,
    [items],
  );

  const mutate = async (item: ScheduledItem, run: () => Promise<{ error?: string | null }>) => {
    setBusyId(item.id);
    const result = await run();
    setBusyId(null);
    if (result.error) setError(result.error);
    await load();
  };

  const deleteItem = (item: ScheduledItem) =>
    void mutate(item, () => del(`/api/scheduler/items/${encodeURIComponent(item.id)}`));
  const toggleItem = (item: ScheduledItem) =>
    void mutate(item, () => patch(`/api/scheduler/items/${encodeURIComponent(item.id)}`, { enabled: item.status === "paused" }));
  const runNow = (item: ScheduledItem) =>
    void mutate(item, () => post(`/api/scheduler/items/${encodeURIComponent(item.id)}/run-now`));

  return (
    <WorkspacePage testId="scheduled-scroll-region" contentClassName="max-w-[960px]">
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-normal text-ink/85">{t("scheduled.title")}</h1>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-ink/40">{t("scheduled.description")}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void load()}
              className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
              style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
            >
              <RotateCw className="h-3.5 w-3.5" />
              {t("common.refresh")}
            </button>
            <button
              type="button"
              onClick={() => setDraft(draft ? null : emptyDraft("prompt"))}
              className="btn-primary flex h-8 items-center gap-1.5 rounded-md px-3 text-[12.5px]"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("scheduled.new")}
            </button>
          </div>
        </header>

        {draft && (
          <ScheduleComposer
            draft={draft}
            onChange={setDraft}
            onCancel={() => setDraft(null)}
            onCreated={() => { setDraft(null); void load(); }}
            permissionLevel={inheritedPermission}
          />
        )}

        {error && (
          <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-[12.5px] text-warning">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("scheduled.error", { error })}</span>
              <button type="button" onClick={() => void load()} className="shrink-0 underline underline-offset-4">
                {t("common.retry")}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center text-ink/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="text-[13px]">{t("scheduled.loading")}</span>
          </div>
        ) : items.length > 0 ? (
          <div className="overflow-hidden rounded-lg border border-ink/[0.06] bg-ink/[0.015]">
            {items.map(item => (
              <ItemRow
                key={item.id}
                item={item}
                locale={locale}
                busy={busyId === item.id}
                onDelete={deleteItem}
                onToggle={toggleItem}
                onRunNow={runNow}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        ) : !draft ? (
          // Empty is the normal first state, so it teaches rather than just
          // reporting emptiness. Each template opens the composer prefilled —
          // nothing here starts running on one click.
          <div className="flex flex-col gap-4">
            <div>
              <p className="text-[13.5px] text-ink/62">{t("scheduled.emptyTitle")}</p>
              <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-ink/36">{t("scheduled.emptyBody")}</p>
            </div>
            <div>
              <h2 className="text-[11px] uppercase tracking-wide text-ink/28">{t("scheduled.templatesTitle")}</h2>
              <div className="mt-2">
                <TemplateGrid onPick={setDraft} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </WorkspacePage>
  );
}
