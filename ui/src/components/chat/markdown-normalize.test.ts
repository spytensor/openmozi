import { describe, expect, it } from "vitest";
import { normalizeMarkdownTables } from "./markdown-normalize";

describe("normalizeMarkdownTables", () => {
  it("rebuilds a collapsed single-line table into multi-line GFM", () => {
    const collapsed = "| Model | Date | | --- | --- | | GPT-5.4 | Mar 5 | | GPT-5.5 | Apr 23 |";
    const out = normalizeMarkdownTables(collapsed);
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("| Model | Date |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| GPT-5.4 | Mar 5 |");
    expect(lines[3]).toBe("| GPT-5.5 | Apr 23 |");
  });

  it("handles CJK content and three columns", () => {
    const collapsed = "| 模型 | 发布时间 | 关键特性 | |---|---|---| | GPT-5.4 | 3月5日 | Computer Use | | GPT-5.5 | 4月23日 | 旗舰升级 |";
    const out = normalizeMarkdownTables(collapsed).trim().split("\n");
    expect(out[0]).toBe("| 模型 | 发布时间 | 关键特性 |");
    expect(out[1]).toBe("| --- | --- | --- |");
    expect(out[2]).toBe("| GPT-5.4 | 3月5日 | Computer Use |");
    expect(out[3]).toBe("| GPT-5.5 | 4月23日 | 旗舰升级 |");
  });

  it("repairs a separator whose column count is less than the header", () => {
    // Real DeepSeek-style output: 3-col header, 2-col separator.
    const bad = "| 模型 | 发布 | 特性 |\n|---|---|\n| GPT-5.4 | 3月5日 | Computer Use |";
    const out = normalizeMarkdownTables(bad).split("\n").filter((l) => l.trim());
    expect(out[0]).toBe("| 模型 | 发布 | 特性 |");
    expect(out[1]).toBe("| --- | --- | --- |");
    expect(out[2]).toBe("| GPT-5.4 | 3月5日 | Computer Use |");
  });

  it("repairs data rows missing a leading pipe", () => {
    const bad = "| A | B |\n|---|---|\n 1 | 2 |\n| 3 | 4 |";
    const out = normalizeMarkdownTables(bad).split("\n").filter((l) => l.trim());
    expect(out[2]).toBe("| 1 | 2 |");
    expect(out[3]).toBe("| 3 | 4 |");
  });

  it("leaves an already well-formed multi-line table untouched (aside from re-normalized spacing)", () => {
    const good = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const out = normalizeMarkdownTables(good).split("\n").filter((l) => l.trim());
    expect(out).toEqual(["| A | B |", "| --- | --- |", "| 1 | 2 |"]);
  });

  it("leaves prose without tables untouched", () => {
    const prose = "This is a sentence with a | pipe but no table separator.";
    expect(normalizeMarkdownTables(prose)).toBe(prose);
  });

  it("leaves text without any pipes untouched", () => {
    const plain = "No pipes here at all.\nSecond line.";
    expect(normalizeMarkdownTables(plain)).toBe(plain);
  });
});
