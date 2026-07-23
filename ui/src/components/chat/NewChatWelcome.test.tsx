import { fireEvent, renderWithLocale, screen } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NewChatWelcome } from "./NewChatWelcome";

describe("NewChatWelcome", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ templates: [] }),
    } as Response)));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders category CARDS; chips appear only after picking a category", () => {
    renderWithLocale(<NewChatWelcome onSelectPrompt={vi.fn()} />, { locale: "en" });

    expect(screen.getByRole("heading")).toHaveTextContent("What would you like MOZI to help with today?");
    // Level one keeps MOZI's own bordered card language (operator decision
    // 2026-07-19: don't copy the competitor's pills) — three category cards
    // plus the "My tasks" card, no chips until one is chosen.
    const cards = screen.getAllByTestId("starter-category-card");
    expect(cards).toHaveLength(3);
    for (const card of [...cards, screen.getByTestId("my-tasks-card")]) {
      expect(card).toHaveStyle({ background: "transparent" });
      expect(card).toHaveAttribute("aria-pressed", "false");
    }
    expect(screen.queryByTestId("starter-chip")).not.toBeInTheDocument();
    expect(screen.queryByTestId("task-template-row")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Research & data/ }));
    expect(screen.getAllByTestId("starter-chip")).toHaveLength(2);
    // Clicking the active card again collapses the chips.
    fireEvent.click(screen.getByRole("button", { name: /Research & data/ }));
    expect(screen.queryByTestId("starter-chip")).not.toBeInTheDocument();
  });

  it("fills the composer with the real detailed brief the chip previews", () => {
    const onSelectPrompt = vi.fn();
    renderWithLocale(<NewChatWelcome onSelectPrompt={onSelectPrompt} />, { locale: "en" });

    fireEvent.click(screen.getByRole("button", { name: /Research & data/ }));
    fireEvent.click(screen.getByRole("button", { name: /E-commerce dataset deep-dive/ }));

    expect(onSelectPrompt).toHaveBeenCalledTimes(1);
    const filled = onSelectPrompt.mock.calls[0][0] as string;
    expect(filled).toContain("archive.ics.uci.edu");
    expect(filled).toContain("pandas");
    expect(filled).toContain("report DOCUMENT");
    expect(filled.length).toBeGreaterThan(400);
    // The hover preview shows the SAME prompt the click fills.
    const previews = screen.getAllByTestId("starter-chip-preview");
    expect(previews.some((node) => node.textContent?.includes("archive.ics.uci.edu"))).toBe(true);
  });

  it("fills a detailed self-contained prompt for every chip in every category", () => {
    const onSelectPrompt = vi.fn();
    renderWithLocale(<NewChatWelcome onSelectPrompt={onSelectPrompt} />, { locale: "en" });

    for (const card of screen.getAllByTestId("starter-category-card")) {
      fireEvent.click(card);
      for (const chip of screen.getAllByTestId("starter-chip")) {
        fireEvent.click(chip);
      }
    }
    expect(onSelectPrompt).toHaveBeenCalledTimes(8);
    for (const call of onSelectPrompt.mock.calls) {
      expect((call[0] as string).length).toBeGreaterThan(150);
    }
    const prompts = onSelectPrompt.mock.calls.map((call) => call[0] as string);
    expect(prompts.filter((p) => /DOCUMENT/.test(p)).length).toBeGreaterThanOrEqual(3);
    expect(prompts.some((p) => p.includes("archive.ics.uci.edu") && /charts? I can see inline/.test(p))).toBe(true);
  });

  it("renders Chinese category cards/chips and the My-tasks card", async () => {
    renderWithLocale(<NewChatWelcome onSelectPrompt={vi.fn()} />, { locale: "zh-CN" });

    expect(screen.getByRole("heading")).toHaveTextContent("今天想让 MOZI 帮你做什么？");
    expect(screen.getByRole("button", { name: /日常办公/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /自动化与文件/ }));
    expect(screen.getByRole("button", { name: /盯网页，变化就通知/ })).toBeInTheDocument();

    // The My-tasks card reveals the saved-task quick-start row (and collapses
    // the starter chips) — with an always-present "new task" entry.
    fireEvent.click(screen.getByRole("button", { name: "我的任务" }));
    expect(screen.queryByTestId("starter-chip")).not.toBeInTheDocument();
    expect(await screen.findByTestId("task-template-new")).toHaveTextContent("新建任务");
  });

  it("quick-starts a saved task from the My-tasks card with one click", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ templates: [{
        id: "00000000-0000-4000-8000-000000000001",
        title: "整理今日邮件",
        instructions: "整理今天收到的邮件",
        output_format: "按优先级分组",
        pinned: true,
        sort_order: 0,
      }] }),
    } as Response)));
    const onSelectPrompt = vi.fn();
    renderWithLocale(<NewChatWelcome onSelectPrompt={onSelectPrompt} />, { locale: "zh-CN" });

    fireEvent.click(screen.getByRole("button", { name: "我的任务" }));
    fireEvent.click(await screen.findByRole("button", { name: /整理今日邮件/ }));

    expect(onSelectPrompt).toHaveBeenCalledWith("整理今天收到的邮件\n\n输出格式：\n按优先级分组");
  });
});
