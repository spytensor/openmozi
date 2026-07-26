import { describe, expect, it } from "vitest";
import { draftToPayload, emptyDraft } from "./ScheduleComposer";

describe("draftToPayload", () => {
  it("builds the cron expression the humaniser reads back", () => {
    // These two must agree: schedule-format.test.ts asserts "15 15 * * 1-5"
    // reads as weekdays at 15:15. A drift here shows up as a task whose card
    // describes a different schedule from the one that was requested.
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "weekdays", time: "15:15" }))
      .toMatchObject({ scheduleKind: "cron", scheduleValue: "15 15 * * 1-5" });
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "daily", time: "09:00" }))
      .toMatchObject({ scheduleValue: "0 9 * * *" });
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "weekly", weekday: 3, time: "07:05" }))
      .toMatchObject({ scheduleValue: "5 7 * * 3" });
  });

  it("sends intervals as milliseconds, which is what the store holds", () => {
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "interval", intervalValue: "30", intervalUnit: "minutes" }))
      .toMatchObject({ scheduleKind: "every", scheduleValue: String(30 * 60_000) });
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "interval", intervalValue: "2", intervalUnit: "hours" }))
      .toMatchObject({ scheduleKind: "every", scheduleValue: String(2 * 3_600_000) });
  });

  it("refuses a draft that cannot make a valid schedule", () => {
    expect(draftToPayload({ ...emptyDraft(), body: "   " })).toBeNull();
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "interval", intervalValue: "0" })).toBeNull();
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "interval", intervalValue: "abc" })).toBeNull();
    expect(draftToPayload({ ...emptyDraft(), body: "x", repeat: "once", onceAt: "not a date" })).toBeNull();
  });

  it("defaults a reminder to a one-shot, since a repeating reminder is a task", () => {
    expect(emptyDraft("reminder").repeat).toBe("once");
    expect(emptyDraft("prompt").repeat).toBe("daily");
  });

  it("carries the kind through so the route picks the right store", () => {
    expect(draftToPayload({ ...emptyDraft("reminder"), body: "stand up" })?.kind).toBe("reminder");
    expect(draftToPayload({ ...emptyDraft("prompt"), body: "report" })?.kind).toBe("prompt");
  });
});
