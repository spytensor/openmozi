import ReactMarkdown from "react-markdown";
import { render, renderWithLocale, screen, waitFor } from "@/test/render";
import { highlightCode, shikiLangForName } from "@/lib/shiki-highlight";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MARKDOWN_COMPONENTS, MarkdownLink, resolveMarkdownLink } from "./markdown-link";

vi.mock("@/lib/shiki-highlight", () => ({
  highlightCode: vi.fn(),
  shikiLangForName: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(highlightCode).mockReset();
  vi.mocked(highlightCode).mockResolvedValue('<pre class="shiki"><code>highlighted</code></pre>');
  vi.mocked(shikiLangForName).mockReset();
  vi.mocked(shikiLangForName).mockReturnValue("javascript");
});

describe("MarkdownLink", () => {
  it("opens absolute http links in a new tab", () => {
    render(<MarkdownLink href="https://example.com/report">Report</MarkdownLink>);

    const link = screen.getByRole("link", { name: "Report" });
    expect(link).toHaveAttribute("href", "https://example.com/report");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  it("normalizes bare domains to https links", () => {
    render(<MarkdownLink href="codebuddy.cn/work">CodeBuddy</MarkdownLink>);

    const link = screen.getByRole("link", { name: "CodeBuddy" });
    expect(link).toHaveAttribute("href", "https://codebuddy.cn/work");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer nofollow");
  });

  it("renders local paths and bare files as plain text", () => {
    const { container, rerender } = render(<MarkdownLink href="/Users/x/a.pptx">Local deck</MarkdownLink>);

    expect(screen.getByText("Local deck")).toBeInTheDocument();
    expect(container.querySelector("a")).not.toBeInTheDocument();

    rerender(<MarkdownLink href="a.pptx">Deck filename</MarkdownLink>);

    expect(screen.getByText("Deck filename")).toBeInTheDocument();
    expect(container.querySelector("a")).not.toBeInTheDocument();
  });

  it("keeps mail and phone links as default anchors", () => {
    const { rerender } = render(<MarkdownLink href="mailto:team@example.com">Email</MarkdownLink>);

    const email = screen.getByRole("link", { name: "Email" });
    expect(email).toHaveAttribute("href", "mailto:team@example.com");
    expect(email).not.toHaveAttribute("target");
    expect(email).not.toHaveAttribute("rel");

    rerender(<MarkdownLink href="tel:+15555550100">Call</MarkdownLink>);

    const phone = screen.getByRole("link", { name: "Call" });
    expect(phone).toHaveAttribute("href", "tel:+15555550100");
    expect(phone).not.toHaveAttribute("target");
    expect(phone).not.toHaveAttribute("rel");
  });

  it("does not promote file-like bare names to domains", () => {
    expect(resolveMarkdownLink("report.pptx")).toEqual({ kind: "plain" });
    expect(resolveMarkdownLink("example.com")).toEqual({ kind: "external", href: "https://example.com" });
  });

  it("leaves document fragments plain outside the dedicated reading surface", () => {
    expect(resolveMarkdownLink("#核心结论")).toEqual({ kind: "plain" });
  });

  it("renders fenced code through the shared shiki highlighter", async () => {
    const { container } = renderWithLocale(
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{"```js\nconst answer = 42;\n```"}</ReactMarkdown>,
    );

    expect(container.querySelector("pre code")).toHaveTextContent("const answer = 42;");
    await waitFor(() => expect(container.querySelector(".shiki")).toBeInTheDocument());
    expect(shikiLangForName).toHaveBeenCalledWith("js");
    expect(highlightCode).toHaveBeenCalledWith("const answer = 42;", "javascript", expect.any(Boolean));
  });

  it("renders inline code without invoking the highlighter", () => {
    const { container } = renderWithLocale(
      <ReactMarkdown components={MARKDOWN_COMPONENTS}>{"Run `npm test` before shipping."}</ReactMarkdown>,
    );

    const code = container.querySelector("code");
    expect(code).toHaveClass("rounded", "font-mono", "text-ink/80");
    expect(code).toHaveTextContent("npm test");
    expect(highlightCode).not.toHaveBeenCalled();
  });
});
