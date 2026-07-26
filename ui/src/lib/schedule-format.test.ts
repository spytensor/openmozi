import { describe, expect, it } from "vitest";
import { formatSchedule, scheduleDetail } from "./schedule-format";

const t = (key: string, vars: Record<string, unknown> = {}) =>
  `${key}(${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")})`;

describe("formatSchedule", () => {
  it("reads the cron shapes an operator actually writes", () => {
    expect(formatSchedule({ kind: "cron", value: "15 15 * * 1-5" }, "en", t)).toBe("schedule.weekdaysAt(time=15:15)");
    expect(formatSchedule({ kind: "cron", value: "0 9 * * *" }, "en", t)).toBe("schedule.dailyAt(time=09:00)");
    expect(formatSchedule({ kind: "cron", value: "30 8 1 * *" }, "en", t)).toBe("schedule.monthlyAt(day=1,time=08:30)");
    // Every day of the week listed is just "daily" — saying "Mon, Tue, …, Sun"
    // would be accurate and useless.
    expect(formatSchedule({ kind: "cron", value: "0 7 * * 0-6" }, "en", t)).toBe("schedule.dailyAt(time=07:00)");
  });

  it("names the weekdays for a partial week", () => {
    const formatted = formatSchedule({ kind: "cron", value: "0 9 * * 1,3" }, "en", t);
    expect(formatted).toContain("schedule.weeklyAt");
    expect(formatted).toContain("Mon");
    expect(formatted).toContain("Wed");
  });

  it("keeps the raw expression rather than inventing a reading it cannot justify", () => {
    // A wrong plain-English schedule is worse than an honest expression, so
    // stepped minutes, listed hours, month constraints and malformed input all
    // fall through untouched.
    for (const value of ["*/5 * * * *", "0 9,17 * * *", "0 9 * 3 *", "not a cron", "0 9 * *"]) {
      expect(formatSchedule({ kind: "cron", value }, "en", t)).toBe(value);
    }
  });

  it("formats intervals at their coarsest honest unit", () => {
    expect(formatSchedule({ kind: "every", value: String(30 * 60_000) }, "en", t)).toBe("schedule.everyMinutes(count=30)");
    expect(formatSchedule({ kind: "every", value: String(2 * 3_600_000) }, "en", t)).toBe("schedule.everyHours(count=2)");
    expect(formatSchedule({ kind: "every", value: String(86_400_000) }, "en", t)).toBe("schedule.everyDays(count=1)");
    expect(formatSchedule({ kind: "every", value: "garbage" }, "en", t)).toBe("garbage");
  });

  it("formats a one-shot as a wall-clock instant", () => {
    const formatted = formatSchedule({ kind: "at", value: "2026-07-27T11:15:00.000Z" }, "en", t);
    expect(formatted.startsWith("schedule.once(when=")).toBe(true);
    expect(formatSchedule({ kind: "at", value: "nonsense" }, "en", t)).toBe("nonsense");
  });
});

describe("scheduleDetail", () => {
  it("offers the expression only when the readable form dropped detail", () => {
    // Humanised: the expression adds nothing, so it is not shown twice.
    expect(scheduleDetail({ kind: "cron", value: "15 15 * * 1-5" }, "en", t)).toBe("15 15 * * 1-5");
    // Not humanised: formatSchedule already returned the expression itself.
    expect(scheduleDetail({ kind: "cron", value: "*/5 * * * *" }, "en", t)).toBeNull();
    expect(scheduleDetail({ kind: "at", value: "2026-07-27T11:15:00.000Z" }, "en", t)).toBeNull();
  });
});
