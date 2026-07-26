/**
 * The draft a scheduled item is built from, and the wire shape it becomes.
 *
 * Split out of ScheduleComposer so the template list can build drafts without
 * importing the component that renders the templates — otherwise the two files
 * import each other.
 */
export type ScheduleDraftKind = "prompt" | "reminder";

export type RepeatMode = "daily" | "weekdays" | "weekly" | "interval" | "once";

export interface ScheduleDraft {
  kind: ScheduleDraftKind;
  body: string;
  repeat: RepeatMode;
  time: string;
  weekday: number;
  intervalValue: string;
  intervalUnit: "minutes" | "hours";
  onceAt: string;
}

/** Tomorrow on the hour, as a `datetime-local` value — a sane default for a one-shot. */
function defaultOnceAt(): string {
  const when = new Date(Date.now() + 24 * 3_600_000);
  when.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function emptyDraft(kind: ScheduleDraftKind = "prompt"): ScheduleDraft {
  return {
    kind,
    body: "",
    // A repeating reminder is just a task, so a reminder starts as a one-shot.
    repeat: kind === "reminder" ? "once" : "daily",
    time: "09:00",
    weekday: 1,
    intervalValue: "30",
    intervalUnit: "minutes",
    onceAt: defaultOnceAt(),
  };
}

/** Draft → the wire shape. Returns null when the draft cannot make a valid schedule. */
export function draftToPayload(draft: ScheduleDraft): {
  kind: ScheduleDraftKind;
  body: string;
  scheduleKind: "cron" | "every" | "at";
  scheduleValue: string;
} | null {
  const body = draft.body.trim();
  if (!body) return null;

  if (draft.repeat === "once") {
    const at = new Date(draft.onceAt);
    if (!Number.isFinite(at.getTime())) return null;
    return { kind: draft.kind, body, scheduleKind: "at", scheduleValue: at.toISOString() };
  }
  if (draft.repeat === "interval") {
    const amount = Number(draft.intervalValue);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const ms = amount * (draft.intervalUnit === "hours" ? 3_600_000 : 60_000);
    return { kind: draft.kind, body, scheduleKind: "every", scheduleValue: String(Math.round(ms)) };
  }

  const [hour, minute] = draft.time.split(":");
  if (!/^\d{1,2}$/.test(hour ?? "") || !/^\d{1,2}$/.test(minute ?? "")) return null;
  const dayOfWeek = draft.repeat === "weekdays" ? "1-5" : draft.repeat === "weekly" ? String(draft.weekday) : "*";
  return {
    kind: draft.kind,
    body,
    scheduleKind: "cron",
    scheduleValue: `${Number(minute)} ${Number(hour)} * * ${dayOfWeek}`,
  };
}
