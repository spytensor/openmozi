import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownReadingSurface, { markdownHeadingSlug } from "./MarkdownReadingSurface";

describe("MarkdownReadingSurface", () => {
  it("gives Unicode headings stable ids and keeps duplicate ids unique", () => {
    render(
      <MarkdownReadingSurface
        markdown={["# 核心结论", "## 风险 / 收益", "## 风险 / 收益"].join("\n\n")}
        variant="document"
      />,
    );

    expect(screen.getByRole("heading", { name: "核心结论" })).toHaveAttribute("id", "核心结论");
    const repeated = screen.getAllByRole("heading", { name: "风险 / 收益" });
    expect(repeated[0]).toHaveAttribute("id", "风险-收益");
    expect(repeated[1]).toHaveAttribute("id", "风险-收益-1");
    expect(markdownHeadingSlug("  Sumsub KYC：能力全景  ")).toBe("sumsub-kyc能力全景");
  });

  it("scrolls authored table-of-contents links inside the current document", () => {
    render(
      <MarkdownReadingSurface
        markdown={["[查看结论](#核心结论)", "# 核心结论", "正文"].join("\n\n")}
        variant="document"
      />,
    );

    const heading = screen.getByRole("heading", { name: "核心结论" });
    const scrollIntoView = vi.fn();
    const focus = vi.fn();
    heading.scrollIntoView = scrollIntoView;
    heading.focus = focus;

    fireEvent.click(screen.getByRole("link", { name: "查看结论" }));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("uses the dedicated reading scale and a semantic framed table", () => {
    const { container, rerender } = render(
      <MarkdownReadingSurface
        markdown={"| 能力 | 结论 |\n| --- | --- |\n| OCR | 可行 |"}
        testId="reading"
        variant="answer"
      />,
    );

    expect(screen.getByTestId("reading")).toHaveClass(
      "text-[14px]",
      "leading-[1.6]",
      "[&_code]:text-code",
      "[&_a]:text-link",
      "[&_h1]:leading-[1.25]",
      "[&_h6]:leading-[1.25]",
      "[&_ul]:!list-disc",
    );
    expect(container.querySelector("[data-markdown-table-frame] table")).toBeInTheDocument();

    rerender(
      <MarkdownReadingSurface markdown="# 文档" testId="reading" variant="document" />,
    );
    expect(screen.getByTestId("reading")).toHaveClass(
      "text-[15px]",
      "leading-[1.7]",
      "[&_h1]:leading-[1.25]",
      "[&_h6]:leading-[1.25]",
      "[&_table]:!w-full",
      "[&_ul]:list-none",
    );
  });
});
