import { afterEach, describe, expect, it, vi } from "vitest";
import { formatRelativeTime } from "./utils";

afterEach(() => {
  vi.useRealTimers();
});

describe("formatRelativeTime", () => {
  it("treats SQLite datetime strings as UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:05:00.000Z"));

    expect(formatRelativeTime("2026-07-01 14:00:00")).toBe("5m ago");
  });

  it("does not show negative relative time for slightly future timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T14:00:00.000Z"));

    expect(formatRelativeTime("2026-07-01T14:00:30.000Z")).toBe("just now");
  });
});
