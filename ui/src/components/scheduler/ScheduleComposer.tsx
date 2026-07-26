/**
 * Creating something to run later.
 *
 * `POST /api/scheduler/tasks` has existed and worked the whole time with no UI
 * caller — a scheduled task could only be created by asking the Brain, which
 * left this page managing something you could not make here. This is that
 * missing surface.
 *
 * Deliberately NOT a copy of a chat composer's control row. A scheduled prompt
 * has no per-task model, skill or agent: `addCronTask` takes none of them, and
 * `managed_brain` runs on the global brain client. Offering those pickers would
 * be claiming capability the runtime does not have. The one thing that really
 * does vary per task — what it is allowed to do while nobody is watching — is
 * shown explicitly rather than silently inherited, which is how a task ended up
 * running at L3_FULL_ACCESS without anyone choosing that.
 */
import { useEffect, useState } from "react";
import { Bell, Sparkles } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { useLocale, type MessageKey } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  draftToPayload,
  emptyDraft,
  type RepeatMode,
  type ScheduleDraft,
  type ScheduleDraftKind,
} from "./draft";
import { TemplateGrid } from "./TemplateGrid";

export { draftToPayload, emptyDraft } from "./draft";
export type { ScheduleDraft, ScheduleDraftKind } from "./draft";

const REPEAT_MODES: RepeatMode[] = ["daily", "weekdays", "weekly", "interval", "once"];
const REPEAT_LABEL: Record<RepeatMode, MessageKey> = {
  daily: "scheduled.repeatDaily",
  weekdays: "scheduled.repeatWeekdays",
  weekly: "scheduled.repeatWeekly",
  interval: "scheduled.repeatInterval",
  once: "scheduled.repeatOnce",
};

export function ScheduleComposer({
  draft,
  onChange,
  onCancel,
  onCreated,
  permissionLevel,
}: {
  draft: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  onCancel: () => void;
  onCreated: () => void;
  permissionLevel?: string | null;
}) {
  const { t, locale } = useLocale();
  const { post } = useApi();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ScheduleDraft>(key: K, value: ScheduleDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const payload = draftToPayload(draft);

  // Escape is the expected way out of an overlay-ish form; without it the only
  // exit was a button that could be scrolled off-screen.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submit = async () => {
    if (!payload) return;
    setSaving(true);
    setError(null);
    const result = await post("/api/scheduler/items", payload);
    setSaving(false);
    if (!result.data) {
      setError(result.error ?? t("common.unavailable"));
      return;
    }
    onCreated();
  };

  const weekdayNames = Array.from({ length: 7 }, (_, day) =>
    new Intl.DateTimeFormat(locale, { weekday: "short" }).format(new Date(Date.UTC(1970, 0, 4 + day))),
  );

  return (
    <section className="rounded-lg border border-ink/[0.08] bg-elevated p-4">
      <div className="flex flex-wrap gap-2">
        {(["prompt", "reminder"] as const).map(kind => {
          const active = draft.kind === kind;
          const Glyph = kind === "prompt" ? Sparkles : Bell;
          return (
            <button
              key={kind}
              type="button"
              onClick={() => onChange({ ...emptyDraft(kind), body: draft.body })}
              aria-pressed={active}
              className={cn(
                "flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors",
                active ? "bg-ink/[0.06]" : "hover:bg-ink/[0.03]",
              )}
            >
              <Glyph
                className={cn("mt-0.5 h-4 w-4 shrink-0", active ? "text-ink/72" : "text-ink/38")}
                strokeWidth={1.75}
              />
              <span className="min-w-0">
                <span className={cn("block text-[12.5px]", active ? "text-ink/82" : "text-ink/58")}>
                  {t(kind === "prompt" ? "scheduled.kindPrompt" : "scheduled.kindReminder")}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-ink/35">
                  {t(kind === "prompt" ? "scheduled.kindPromptHint" : "scheduled.kindReminderHint")}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <textarea
        value={draft.body}
        onChange={event => set("body", event.target.value)}
        rows={3}
        autoFocus
        placeholder={t(draft.kind === "prompt" ? "scheduled.bodyPromptPlaceholder" : "scheduled.bodyReminderPlaceholder")}
        className="mt-3 w-full resize-y rounded-md bg-ink/[0.03] px-3 py-2.5 text-[13px] leading-5 text-ink/82 outline-none placeholder:text-ink/28 focus:bg-ink/[0.045]"
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-[12px]">
        <span className="text-ink/38">{t("scheduled.repeat")}</span>
        {REPEAT_MODES.map(mode => (
          <button
            key={mode}
            type="button"
            onClick={() => set("repeat", mode)}
            aria-pressed={draft.repeat === mode}
            className={cn(
              "rounded-md px-2 py-1 transition-colors",
              draft.repeat === mode ? "bg-ink/[0.08] text-ink/82" : "text-ink/45 hover:text-ink/62",
            )}
          >
            {t(REPEAT_LABEL[mode])}
          </button>
        ))}
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[12px] text-ink/58">
        {draft.repeat === "weekly" && (
          <>
            <span className="text-ink/38">{t("scheduled.onDay")}</span>
            <select
              value={draft.weekday}
              onChange={event => set("weekday", Number(event.target.value))}
              className="rounded-md bg-ink/[0.04] px-2 py-1 text-ink/82 outline-none"
            >
              {weekdayNames.map((name, day) => (
                <option key={name} value={day}>{name}</option>
              ))}
            </select>
          </>
        )}

        {(draft.repeat === "daily" || draft.repeat === "weekdays" || draft.repeat === "weekly") && (
          <>
            <span className="text-ink/38">{t("scheduled.atTime")}</span>
            <input
              type="time"
              value={draft.time}
              onChange={event => set("time", event.target.value)}
              className="rounded-md bg-ink/[0.04] px-2 py-1 text-ink/82 outline-none"
            />
          </>
        )}

        {draft.repeat === "interval" && (
          <>
            <input
              type="number"
              min={1}
              value={draft.intervalValue}
              onChange={event => set("intervalValue", event.target.value)}
              className="w-20 rounded-md bg-ink/[0.04] px-2 py-1 text-ink/82 outline-none"
            />
            <select
              value={draft.intervalUnit}
              onChange={event => set("intervalUnit", event.target.value as ScheduleDraft["intervalUnit"])}
              className="rounded-md bg-ink/[0.04] px-2 py-1 text-ink/82 outline-none"
            >
              <option value="minutes">{t("scheduled.intervalMinutes")}</option>
              <option value="hours">{t("scheduled.intervalHours")}</option>
            </select>
          </>
        )}

        {draft.repeat === "once" && (
          <input
            type="datetime-local"
            value={draft.onceAt}
            onChange={event => set("onceAt", event.target.value)}
            className="rounded-md bg-ink/[0.04] px-2 py-1 text-ink/82 outline-none"
          />
        )}
      </div>

      {/* Only a prompt runs with privileges; a reminder just sends a message, and
          showing a level for it would imply a capability it does not have. */}
      {draft.kind === "prompt" && permissionLevel && (
        <p className="mt-3 text-[11px] text-ink/38">
          {t("scheduled.runsAt", { level: permissionLevel })}
          <span className="text-ink/28"> · {t("scheduled.runsAtHint")}</span>
        </p>
      )}

      {/* Save and cancel sit directly under the field they act on. They used to
          follow the examples, which pushed them below the fold whenever the
          body was blank — so "I changed my mind" meant scrolling past ten cards
          to find the way out. */}
      {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!payload || saving}
          className="btn-primary h-8 rounded-md px-3 text-[12.5px] disabled:opacity-40"
        >
          {saving ? t("scheduled.saving") : t("scheduled.save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded-md px-3 text-[12.5px] text-ink/45 transition-colors hover:text-ink/72"
        >
          {t("scheduled.cancel")}
        </button>
      </div>

      {/* Examples come after the field they fill in, not in front of it: they are
          a way to start, not the point of the form. They disappear as soon as
          there is something to schedule. */}
      {!draft.body.trim() && (
        <div className="mt-3.5">
          <h3 className="text-[11px] uppercase tracking-wide text-ink/28">{t("scheduled.templatesTitle")}</h3>
          <div className="mt-2">
            <TemplateGrid columns={2} onPick={onChange} />
          </div>
        </div>
      )}

    </section>
  );
}
