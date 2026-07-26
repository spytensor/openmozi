/**
 * Turn a stored schedule into something an operator reads without decoding.
 *
 * The task card used to lead with `cron: 15 15 * * 1-5 · managed_brain` — the
 * raw expression and the internal handler id as the primary description. The
 * expression is still worth having, but as a detail, not as the headline.
 *
 * Only the shapes MOZI actually stores are handled: `at` is an ISO instant,
 * `every` is a millisecond count as a string, `cron` is a 5-field expression.
 * Anything a formatter cannot read falls back to the raw value rather than
 * guessing — a wrong plain-English schedule is worse than an honest expression.
 */
export type ScheduleKind = "cron" | "every" | "at";

export interface ScheduleShape {
  kind: ScheduleKind;
  value: string;
  timezone?: string | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function formatInterval(ms: number, t: (key: string, vars?: Record<string, unknown>) => string): string {
  if (ms % DAY === 0) return t("schedule.everyDays", { count: ms / DAY });
  if (ms % HOUR === 0) return t("schedule.everyHours", { count: ms / HOUR });
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  return t("schedule.everyMinutes", { count: minutes });
}

/** A bare wildcard is the only "any value" form this reads; stepped fields are not humanised. */
function isEvery(field: string): boolean {
  return field === "*";
}

function parseDayList(field: string): number[] | null {
  if (isEvery(field)) return null;
  const parts: number[] = [];
  for (const chunk of field.split(",")) {
    const range = chunk.match(/^(\d)-(\d)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to) return null;
      for (let day = from; day <= to; day += 1) parts.push(day % 7);
      continue;
    }
    if (!/^\d$/.test(chunk)) return null;
    parts.push(Number(chunk) % 7);
  }
  return parts.length > 0 ? [...new Set(parts)].sort() : null;
}

function weekdayNames(days: number[], locale: string): string {
  // 1970-01-04 was a Sunday, so adding the cron day number lands on that weekday.
  const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return days.map(day => formatter.format(new Date(Date.UTC(1970, 0, 4 + day)))).join(", ");
}

function formatCron(
  expression: string,
  locale: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  // Only exact times are humanised. A cron with stepped or listed hours has no
  // short honest phrasing, so it keeps its expression.
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  if (!isEvery(month)) return null;

  const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

  if (isEvery(dayOfMonth) && isEvery(dayOfWeek)) return t("schedule.dailyAt", { time });
  if (isEvery(dayOfWeek) && /^\d{1,2}$/.test(dayOfMonth)) {
    return t("schedule.monthlyAt", { day: dayOfMonth, time });
  }
  if (isEvery(dayOfMonth)) {
    const days = parseDayList(dayOfWeek);
    if (!days) return null;
    if (days.length === 5 && days.every(day => day >= 1 && day <= 5)) {
      return t("schedule.weekdaysAt", { time });
    }
    if (days.length === 7) return t("schedule.dailyAt", { time });
    return t("schedule.weeklyAt", { days: weekdayNames(days, locale), time });
  }
  return null;
}

/**
 * Plain-language schedule, or the raw value when it cannot be read honestly.
 */
export function formatSchedule(
  schedule: ScheduleShape,
  locale: string,
  t: (key: string, vars?: Record<string, unknown>) => string,
): string {
  if (schedule.kind === "at") {
    const at = Date.parse(schedule.value);
    if (!Number.isFinite(at)) return schedule.value;
    return t("schedule.once", {
      when: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at),
    });
  }
  if (schedule.kind === "every") {
    const ms = Number(schedule.value);
    if (!Number.isSafeInteger(ms) || ms <= 0) return schedule.value;
    return formatInterval(ms, t);
  }
  return formatCron(schedule.value, locale, t) ?? schedule.value;
}

/**
 * The raw expression, shown only where the plain-language form loses detail.
 * Returns null when the formatted form already says everything.
 */
export function scheduleDetail(schedule: ScheduleShape, locale: string, t: (key: string, vars?: Record<string, unknown>) => string): string | null {
  if (schedule.kind !== "cron") return null;
  return formatSchedule(schedule, locale, t) === schedule.value ? null : schedule.value;
}
