import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { AlertCircle, Bell, CalendarClock, ChevronDown, ChevronRight, CirclePlay, Loader2, Pause, Play, Plus, RotateCw, Trash2 } from "lucide-react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";

interface SchedulerTask {
  id?: string;
  description?: string;
  name?: string;
  title?: string;
  schedule_kind?: string;
  schedule_value?: string;
  timezone?: string | null;
  handler_type?: string;
  next_run_at?: string | null;
  next_run?: string | null;
  nextRunAt?: string | null;
  last_status?: string | null;
  lastStatus?: string | null;
  status?: string | null;
  last_error?: string | null;
  lastError?: string | null;
  error?: string | null;
  enabled?: number;
  permission_level?: string | null;
  runs?: SchedulerRun[];
}

interface SchedulerRun {
  id: string;
  session_id?: string | null;
  scheduled_for: string;
  trigger_origin?: "schedule" | "manual";
  status: string;
  started_at?: string | null;
  completed_at?: string | null;
}

interface Reminder {
  id: number;
  chat_id: string;
  message: string;
  fire_at: string;
  fired: number;
  status?: string;
  last_error?: string | null;
}

type StatusTone = "active" | "ok" | "failed" | "unknown";

function normalizeTasks(payload: unknown): SchedulerTask[] {
  if (Array.isArray(payload)) return payload as SchedulerTask[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.tasks)) return record.tasks as SchedulerTask[];
  return [];
}

function normalizeReminders(payload: unknown): Reminder[] {
  if (Array.isArray(payload)) return payload as Reminder[];
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.reminders)) return record.reminders as Reminder[];
  return [];
}

function taskName(task: SchedulerTask): string | null {
  return task.description || task.name || task.title || null;
}

function nextRunValue(task: SchedulerTask): string | null {
  return task.next_run_at || task.next_run || task.nextRunAt || null;
}

function lastStatusValue(task: SchedulerTask): string | null {
  return task.last_status || task.lastStatus || task.status || null;
}

function lastErrorValue(task: SchedulerTask): string | null {
  return task.last_error || task.lastError || task.error || null;
}

function statusTone(status: string | null): StatusTone {
  const normalized = (status ?? "").toLowerCase();
  if (["queued", "running"].includes(normalized)) return "active";
  if (["ok", "success", "succeeded", "completed", "done"].includes(normalized)) return "ok";
  if (["failed", "failure", "error", "errored"].includes(normalized)) return "failed";
  return "unknown";
}

function normalizedDate(value: string): string {
  return /(?:z|[+-]\d{2}:?\d{2})$/i.test(value.trim())
    ? value
    : `${value.trim().replace(" ", "T")}Z`;
}

function formatNextRun(value: string | null, locale: string, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(normalizedDate(value));
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function runDuration(run: SchedulerRun): { minutes: number; seconds: number } | null {
  if (!run.started_at || !run.completed_at) return null;
  const elapsed = Date.parse(normalizedDate(run.completed_at)) - Date.parse(normalizedDate(run.started_at));
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const totalSeconds = Math.floor(elapsed / 1000);
  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

export default function ScheduledView({ onOpenSession }: { onOpenSession?: (sessionId: string) => void }) {
  const { locale, t } = useLocale();
  const { get, post, patch, del } = useApi();
  const [tasks, setTasks] = useState<SchedulerTask[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [remindersLoading, setRemindersLoading] = useState(true);
  const [reminderMessage, setReminderMessage] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("15");
  const [submittingReminder, setSubmittingReminder] = useState(false);
  const [deletingTaskId, setDeletingTaskId] = useState<string | null>(null);
  const [togglingTaskId, setTogglingTaskId] = useState<string | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [deletingReminderId, setDeletingReminderId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remindersError, setRemindersError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await get<unknown>("/api/scheduler/tasks");
    if (result.error) {
      setTasks([]);
      setError(result.error);
    } else {
      setTasks(normalizeTasks(result.data));
    }
    setLoading(false);
  }, [get]);

  const loadReminders = useCallback(async () => {
    setRemindersLoading(true);
    setRemindersError(null);
    const result = await get<unknown>("/api/scheduler/reminders");
    if (result.error) {
      setReminders([]);
      setRemindersError(result.error);
    } else {
      setReminders(normalizeReminders(result.data));
    }
    setRemindersLoading(false);
  }, [get]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadReminders();
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadReminders]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      const aTime = Date.parse(nextRunValue(a) ?? "");
      const bTime = Date.parse(nextRunValue(b) ?? "");
      return (Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER);
    });
  }, [tasks]);

  const sortedReminders = useMemo(() => {
    return [...reminders].sort((a, b) => {
      const normalize = (value: string) => /(?:z|[+-]\d{2}:?\d{2})$/i.test(value.trim())
        ? value
        : `${value.trim().replace(" ", "T")}Z`;
      const aTime = Date.parse(normalize(a.fire_at));
      const bTime = Date.parse(normalize(b.fire_at));
      return (Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER);
    });
  }, [reminders]);

  const addReminder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const message = reminderMessage.trim();
    const minutes = Number(delayMinutes);
    if (!message || !Number.isFinite(minutes) || minutes <= 0) return;
    setSubmittingReminder(true);
    setRemindersError(null);
    const result = await post("/api/scheduler/reminders", {
      message,
      delayMinutes: minutes,
    });
    setSubmittingReminder(false);
    if (result.error) {
      setRemindersError(result.error);
      return;
    }
    setReminderMessage("");
    void loadReminders();
  };

  const deleteReminder = async (reminder: Reminder) => {
    if (!window.confirm(t("scheduler.reminder_delete_confirm", { name: reminder.message }))) return;
    setDeletingReminderId(reminder.id);
    setRemindersError(null);
    const result = await del(`/api/scheduler/reminders/${reminder.id}`);
    setDeletingReminderId(null);
    if (result.error) {
      setRemindersError(result.error);
      return;
    }
    void loadReminders();
  };

  const deleteTask = async (task: SchedulerTask) => {
    if (!task.id) return;
    if (!window.confirm(t("scheduler.task_delete_confirm", { name: taskName(task) ?? task.id }))) return;
    setDeletingTaskId(task.id);
    setError(null);
    const result = await del(`/api/scheduler/tasks/${encodeURIComponent(task.id)}`);
    setDeletingTaskId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    void loadTasks();
  };

  const toggleTask = async (task: SchedulerTask) => {
    if (!task.id) return;
    setTogglingTaskId(task.id);
    setError(null);
    const result = await patch(`/api/scheduler/tasks/${encodeURIComponent(task.id)}`, {
      enabled: task.enabled === 0,
    });
    setTogglingTaskId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    void loadTasks();
  };

  const runTaskNow = async (task: SchedulerTask) => {
    if (!task.id) return;
    setRunningTaskId(task.id);
    setError(null);
    const result = await post(`/api/scheduler/tasks/${encodeURIComponent(task.id)}/run-now`);
    setRunningTaskId(null);
    if (result.error) {
      setError(result.error);
      return;
    }
    void loadTasks();
  };

  return (
    <WorkspacePage testId="scheduled-scroll-region" contentClassName="max-w-[960px]">
      <div className="flex flex-col gap-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[22px] font-semibold tracking-normal text-ink/85">{t("scheduled.title")}</h1>
            <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-ink/40">{t("scheduled.description")}</p>
          </div>
          <button
            type="button"
            onClick={() => { void loadTasks(); void loadReminders(); }}
            className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
            style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
          >
            <RotateCw className="h-3.5 w-3.5" />
            {t("common.refresh")}
          </button>
        </header>

        {loading ? (
          <div className="flex min-h-[220px] items-center justify-center text-ink/45">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            <span className="text-[13px]">{t("scheduled.loading")}</span>
          </div>
        ) : error ? (
          <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-[12.5px] text-warning">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{t("scheduled.error", { error })}</span>
              <button type="button" onClick={() => void loadTasks()} className="shrink-0 underline underline-offset-4">
                {t("common.retry")}
              </button>
            </div>
          </div>
        ) : sortedTasks.length === 0 ? (
          // Empty is the normal state, not an event — one quiet line, no
          // bordered billboard box around blank space.
          <p className="py-4 text-[13px] leading-6 text-ink/36">{t("scheduled.empty")}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-ink/[0.06] bg-ink/[0.015]">
            {sortedTasks.map((task, index) => (
              <ScheduledTaskRow
                key={task.id ?? `${taskName(task) ?? "task"}-${index}`}
                task={task}
                locale={locale}
                deleting={!!task.id && deletingTaskId === task.id}
                toggling={!!task.id && togglingTaskId === task.id}
                running={!!task.id && runningTaskId === task.id}
                onDelete={deleteTask}
                onToggle={toggleTask}
                onRunNow={runTaskNow}
                onOpenSession={onOpenSession}
              />
            ))}
          </div>
        )}

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-[16px] font-semibold text-ink/82">{t("scheduler.reminders_section")}</h2>
          </div>

          {/* The inputs carry their own surfaces — no wrapper card around a
              form row (box-in-box reads as dead chrome). */}
          <form
            onSubmit={(event) => void addReminder(event)}
            className="grid gap-2 md:grid-cols-[minmax(0,1fr)_140px_auto] md:items-end"
          >
            <label className="min-w-0">
              <span className="sr-only">{t("scheduler.new_reminder")}</span>
              <input
                value={reminderMessage}
                onChange={(event) => setReminderMessage(event.target.value)}
                placeholder={t("scheduler.reminder_message_placeholder")}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              />
            </label>
            <label className="min-w-0">
              <span className="mb-1 block text-[11px] text-ink/45">{t("scheduler.reminder_delay_label")}</span>
              <input
                type="number"
                min="1"
                value={delayMinutes}
                onChange={(event) => setDelayMinutes(event.target.value)}
                className="h-9 w-full rounded-md border px-2.5 text-[13px] outline-none"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              />
            </label>
            <button
              type="submit"
              disabled={submittingReminder || !reminderMessage.trim() || Number(delayMinutes) <= 0}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--action)", color: "var(--action-fg)" }}
            >
              {submittingReminder ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              {t("scheduler.reminder_add_button")}
            </button>
          </form>

          {remindersError && (
            <div className="rounded-lg border border-warning/20 bg-warning/10 p-3 text-[12.5px] text-warning">
              {t("scheduler.reminders_error", { error: remindersError })}
            </div>
          )}

          {remindersLoading ? (
            <div className="flex min-h-[96px] items-center justify-center text-ink/45">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              <span className="text-[13px]">{t("scheduler.reminders_loading")}</span>
            </div>
          ) : sortedReminders.length === 0 ? (
            <p className="py-2 text-[13px] leading-6 text-ink/36">{t("scheduler.no_reminders")}</p>
          ) : (
            <div className="overflow-hidden rounded-lg border border-ink/[0.06] bg-ink/[0.015]">
              {sortedReminders.map((reminder) => (
                <ReminderRow
                  key={reminder.id}
                  reminder={reminder}
                  locale={locale}
                  deleting={deletingReminderId === reminder.id}
                  onDelete={deleteReminder}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </WorkspacePage>
  );
}

function ScheduledTaskRow({
  task,
  locale,
  deleting,
  toggling,
  running,
  onDelete,
  onToggle,
  onRunNow,
  onOpenSession,
}: {
  task: SchedulerTask;
  locale: string;
  deleting: boolean;
  toggling: boolean;
  running: boolean;
  onDelete: (task: SchedulerTask) => void;
  onToggle: (task: SchedulerTask) => void;
  onRunNow: (task: SchedulerTask) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useLocale();
  const status = lastStatusValue(task);
  const tone = statusTone(status);
  const lastError = lastErrorValue(task);
  const paused = task.enabled === 0;
  const activeStatus = !paused && tone === "active";
  const activeRunEntry = task.runs?.find(run => ["queued", "running"].includes(run.status.toLowerCase()));
  const hasActiveRun = [lastStatusValue(task), ...(task.runs ?? []).map(run => run.status)]
    .some(value => value != null && ["queued", "running", "retrying"].includes(value.toLowerCase()));
  const nextRun = paused ? "" : formatNextRun(nextRunValue(task), locale, t("scheduled.noNextRun"));
  const statusLabel = tone === "ok"
    ? t("scheduled.status.ok")
    : tone === "failed"
      ? t("scheduled.status.failed")
      : status === "queued"
        ? t("scheduled.status.queued")
        : status === "running"
          ? t("scheduled.status.running")
          : status === "retrying"
            ? t("scheduled.status.retrying")
            : t("scheduled.status.unknown");
  const dotColor = !paused && tone === "ok" ? "var(--success)" : !paused && tone === "failed" ? "var(--danger)" : "rgb(var(--ink-rgb) / 0.24)";
  const statusContent = (
    <>
      <span
        data-testid={`task-status-dot-${task.id ?? "unknown"}`}
        className={`h-2 w-2 rounded-full ${activeStatus ? "bg-activity pulse-dot" : ""}`}
        style={activeStatus ? undefined : { background: dotColor }}
      />
      {statusLabel}
    </>
  );

  return (
    <article className="border-b border-ink/[0.045] px-3 py-3 last:border-b-0">
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_minmax(120px,180px)_auto] md:items-start">
      <div className="flex min-w-0 items-start gap-2">
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-ink/38" />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[13.5px] font-medium text-ink/82">{taskName(task) ?? t("scheduled.unnamed")}</h2>
            {paused && <span className="shrink-0 text-[11px] text-warning">{t("scheduled.paused")}</span>}
          </div>
          {(task.schedule_kind || task.handler_type) && (
            <p className="mt-0.5 truncate text-[11px] text-ink/38">
              {[task.schedule_kind && `${task.schedule_kind}: ${task.schedule_value ?? ""}`, task.handler_type]
                .filter(Boolean).join(" · ")}
            </p>
          )}
          {task.permission_level && (
            <p className="mt-0.5 text-[11px] text-ink/38">
              {t("scheduled.permissionLevel", { level: task.permission_level })}
            </p>
          )}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase text-ink/28">{t("scheduled.nextRun")}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink/62">{nextRun}</div>
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase text-ink/28">{t("scheduled.lastStatus")}</div>
        {tone === "failed" && lastError ? (
          <details className="mt-0.5">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] text-ink/64" title={lastError}>
              {statusContent}
            </summary>
            <p className="mt-1 overflow-wrap-anywhere rounded-md bg-danger/10 px-2 py-1.5 text-[11px] leading-4 text-danger" title={lastError}>
              {lastError}
            </p>
          </details>
        ) : (
          activeStatus && activeRunEntry?.session_id ? (
            <a
              href={`#/session/${encodeURIComponent(activeRunEntry.session_id)}`}
              onClick={(event) => {
                if (!onOpenSession) return;
                event.preventDefault();
                onOpenSession(activeRunEntry.session_id!);
              }}
              className="mt-0.5 flex w-fit items-center gap-1.5 text-[12.5px] text-activity underline underline-offset-2 hover:text-activity/80"
              title={t("scheduler.view_live_run")}
            >
              <span
                data-testid={`task-status-dot-${task.id ?? "unknown"}`}
                className="h-2 w-2 rounded-full bg-activity pulse-dot"
              />
              {t("scheduler.running_view_live")}
              <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          ) : (
            <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink/64" title={lastError ?? statusLabel}>
              {statusContent}
            </div>
          )
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onRunNow(task)}
          disabled={!task.id || hasActiveRun || running}
          title={hasActiveRun ? t("scheduler.task_run_active") : running ? t("scheduler.task_run_starting") : t("scheduler.task_run_now")}
          className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-[11.5px] text-ink/55 transition-colors hover:bg-ink/[0.05] hover:text-ink/75 disabled:opacity-40"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CirclePlay className="h-3.5 w-3.5" />}
          {t("scheduler.task_run_now")}
        </button>
        <button
          type="button"
          onClick={() => onToggle(task)}
          disabled={!task.id || toggling}
          title={paused ? t("scheduler.task_resume") : t("scheduler.task_pause")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.05] hover:text-ink/70 disabled:opacity-40"
        >
          {toggling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={() => onDelete(task)}
          disabled={!task.id || deleting}
          title={t("scheduler.task_delete")}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
        >
          {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      </div>
      <details className="group mt-2 border-t border-ink/[0.045] pt-2">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[11.5px] text-ink/45 hover:text-ink/70">
          <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
          {t("scheduler.run_history")}
        </summary>
        {(task.runs ?? []).length === 0 ? (
          <p className="pt-2 text-[12px] text-ink/36">{t("scheduler.run_history_empty")}</p>
        ) : (
          <div className="pt-1">
            {(task.runs ?? []).slice(0, 10).map(run => {
              const runTone = statusTone(run.status);
              const duration = runDuration(run);
              const runStatus = runTone === "ok"
                ? t("scheduled.status.ok")
                : runTone === "failed"
                  ? t("scheduled.status.failed")
                  : run.status === "queued"
                    ? t("scheduled.status.queued")
                    : run.status === "running"
                      ? t("scheduled.status.running")
                      : t("scheduled.status.unknown");
              const durationLabel = run.status.toLowerCase() === "running"
                ? t("scheduler.run_in_progress")
                : duration
                  ? duration.minutes > 0
                    ? t("scheduler.run_duration_minutes", duration)
                    : t("scheduler.run_duration_seconds", duration)
                  : "—";
              const content = (
                <>
                  <span>{formatNextRun(run.started_at ?? null, locale, "—")}</span>
                  <span>{run.trigger_origin === "manual" ? t("scheduler.run_origin_manual") : t("scheduler.run_origin_schedule")}</span>
                  <span>{runStatus}</span>
                  <span className="text-right">{durationLabel}</span>
                </>
              );
              return run.session_id ? (
                <a
                  key={run.id}
                  href={`#/session/${encodeURIComponent(run.session_id)}`}
                  onClick={(event) => {
                    if (!onOpenSession) return;
                    event.preventDefault();
                    onOpenSession(run.session_id!);
                  }}
                  className="grid grid-cols-[minmax(0,1fr)_56px_64px_72px] gap-2 border-t border-ink/[0.035] py-1.5 text-[11px] text-ink/48 first:border-t-0 hover:text-ink/75"
                >
                  {content}
                </a>
              ) : (
                <div key={run.id} className="grid grid-cols-[minmax(0,1fr)_56px_64px_72px] gap-2 border-t border-ink/[0.035] py-1.5 text-[11px] text-ink/40 first:border-t-0">
                  {content}
                </div>
              );
            })}
          </div>
        )}
      </details>
    </article>
  );
}

function ReminderRow({
  reminder,
  locale,
  deleting,
  onDelete,
}: {
  reminder: Reminder;
  locale: string;
  deleting: boolean;
  onDelete: (reminder: Reminder) => void;
}) {
  const { t } = useLocale();
  const status = reminder.status || (reminder.fired !== 0 ? "delivered" : "pending");
  const label = status === "delivered"
    ? t("scheduler.reminder_fired")
    : status === "failed"
      ? t("scheduled.status.failed")
      : status === "pending"
        ? t("scheduler.reminder_pending")
        : status === "retrying"
          ? t("scheduled.status.retrying")
          : status === "delivering"
            ? t("scheduled.status.running")
            : t("scheduled.status.unknown");
  const dotColor = status === "delivered" ? "var(--success)" : status === "failed" ? "var(--danger)" : "var(--activity)";

  return (
    <article className="grid gap-2 border-b border-ink/[0.045] px-3 py-3 last:border-b-0 md:grid-cols-[minmax(0,1fr)_minmax(160px,220px)_minmax(90px,120px)_auto] md:items-start">
      <div className="flex min-w-0 items-start gap-2">
        <Bell className="mt-0.5 h-4 w-4 shrink-0 text-ink/38" />
        <div className="min-w-0">
          <h3 className="overflow-wrap-anywhere text-[13.5px] font-medium text-ink/82">{reminder.message}</h3>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[10.5px] uppercase text-ink/28">{t("scheduler.reminder_fire_at")}</div>
        <div className="mt-0.5 truncate text-[12.5px] text-ink/62">{formatNextRun(reminder.fire_at, locale, t("scheduled.noNextRun"))}</div>
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-ink/64">
        <span className="h-2 w-2 rounded-full" style={{ background: dotColor }} />
        {label}
      </div>
      <button
        type="button"
        onClick={() => onDelete(reminder)}
        disabled={deleting}
        title={t("scheduler.reminder_delete")}
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40"
      >
        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
    </article>
  );
}
