import { describe, expect, it, vi } from "vitest";
import { formatApproximateDurationForLocale, formatRelativeTimeForLocale } from "./format";
import { LOCALES, translateMessage } from "./messages";
import { LOCALE_REGISTRY } from "./locales";

describe("i18n", () => {
  it("translates shared UI keys by locale", () => {
    expect(translateMessage("en", "sidebar.newChat")).toBe("New chat");
    expect(translateMessage("zh-CN", "sidebar.newChat")).toBe("新会话");
  });

  it("keeps the locale registry and new secondary-surface copy complete", () => {
    expect(LOCALE_REGISTRY.map(({ id }) => id)).toEqual([...LOCALES]);
    expect(LOCALE_REGISTRY.map(({ label }) => label)).toEqual(["English", "简体中文"]);
    for (const locale of LOCALES) {
      for (const key of ["settings.close", "settings.sections", "files.showLocation", "files.hideLocation"] as const) {
        expect(translateMessage(locale, key)).not.toBe(key);
      }
    }
  });

  it("keeps model-usage Token terminology distinct from authentication sessions", () => {
    const usageKeys = [
      "admin.usage.description",
      "admin.usage.dailyTokens",
      "admin.usage.monthlyTokens",
      "admin.usage.quotaDescription",
      "admin.usage.dailyLimit",
      "admin.usage.monthlyLimit",
      "admin.usage.totalTokens",
      "admin.usage.cacheTokens",
      "admin.usage.observedUsage",
      "admin.usage.usageUnavailable",
      "admin.usage.tokenTrend",
      "composer.command.budget",
    ] as const;

    for (const key of usageKeys) {
      const translated = translateMessage("zh-CN", key, { requests: 3, cached: 128 });
      expect(translated).toContain("Token");
      expect(translated).not.toContain("令牌");
    }
    expect(translateMessage("zh-CN", "admin.users.confirmDisableBody")).toContain("登录会话");
    expect(translateMessage("zh-CN", "admin.users.confirmDisableBody")).not.toContain("Token");
  });

  it("formats relative time without mixing locales", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-02T12:00:00.000Z"));

    const timestamp = "2026-07-02T10:00:00.000Z";
    expect(formatRelativeTimeForLocale(timestamp, "en")).toBe("2h ago");
    expect(formatRelativeTimeForLocale(timestamp, "zh-CN")).toBe("2 小时前");

    vi.useRealTimers();
  });

  it("formats approximate activity duration without seconds or milliseconds in either locale", () => {
    expect(formatApproximateDurationForLocale(59_999, "en")).toBeNull();
    expect(formatApproximateDurationForLocale(60_000, "en")).toBe("about 1 min");
    expect(formatApproximateDurationForLocale(125_000, "zh-CN")).toBe("已处理约 2 分钟");
    for (const locale of LOCALES) {
      const value = formatApproximateDurationForLocale(125_000, locale);
      expect(value).not.toMatch(/ms|毫秒|秒|\d+s\b/);
      expect(translateMessage(locale, "execution.summary.viewWork")).not.toBe("execution.summary.viewWork");
      expect(translateMessage(locale, "execution.details.technical")).not.toBe("execution.details.technical");
    }
  });
});
