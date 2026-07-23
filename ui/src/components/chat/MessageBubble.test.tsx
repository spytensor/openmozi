import { fireEvent, screen, renderWithLocale, waitFor } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/types";
import MessageBubble, { normalizeAssistantMarkdown } from "./MessageBubble";

function message(role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id: `${role}-1`,
    role,
    content,
    timestamp: 1,
  };
}

function hasFrameClass(element: HTMLElement) {
  return element.className
    .split(/\s+/)
    .some((token) => token.startsWith("bg-") || token.startsWith("border") || token.startsWith("rounded"));
}

function hasExactClass(element: HTMLElement, className: string) {
  return element.className.split(/\s+/).includes(className);
}

describe("MessageBubble", () => {
  it("renders provider failures as a structured retry state without raw JSON", () => {
    const onRegenerate = vi.fn();
    renderWithLocale(
      <MessageBubble
        message={message("assistant", 'Request failed: provider connection closed {"type":"error","request_id":"secret"}')}
        onRegenerate={onRegenerate}
        regenerateText="Book the hotel"
      />,
    );

    expect(screen.getByTestId("message-error")).toHaveTextContent("Request failed");
    expect(screen.queryByText(/request_id/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRegenerate).toHaveBeenCalledWith("Book the hotel");
  });

  it("offers settings instead of retry for exhausted provider quota", () => {
    const onRegenerate = vi.fn();
    const onOpenModelSettings = vi.fn();
    renderWithLocale(
      <MessageBubble
        message={message("assistant", "Request failed because the current provider account hit a quota/balance limit. Please recharge or switch to another configured provider, then retry.")}
        onRegenerate={onRegenerate}
        regenerateText="Build the report"
        onOpenModelSettings={onOpenModelSettings}
      />,
    );

    expect(screen.getByTestId("message-error")).toHaveTextContent("Provider quota reached");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open model settings" }));
    expect(onOpenModelSettings).toHaveBeenCalledTimes(1);
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("offers settings instead of retry for provider authentication failures", () => {
    renderWithLocale(
      <MessageBubble
        message={message("assistant", "Request failed because the current provider API key is invalid. Update the provider key in Settings, then retry.")}
        onRegenerate={vi.fn()}
        regenerateText="Build the report"
        onOpenModelSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId("message-error")).toHaveTextContent("Provider authentication failed");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open model settings" })).toBeInTheDocument();
  });
  it("collapses assistant prose blank lines without touching fenced code", () => {
    expect(
      normalizeAssistantMarkdown(
        "\n\nFirst paragraph\n\n\n\nSecond paragraph\n\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\n\nThird paragraph\n\n",
      ),
    ).toBe("First paragraph\n\nSecond paragraph\n\n```ts\nconst a = 1;\n\n\nconst b = 2;\n```\n\nThird paragraph");
  });

  it("keeps assistant output unframed in the workspace", () => {
    renderWithLocale(<MessageBubble message={message("assistant", "MOZI has finished the work.")} />);

    const assistant = screen.getByTestId("message-assistant");
    const content = screen.getByTestId("message-assistant-content");

    expect(assistant).toHaveTextContent("MOZI has finished the work.");
    expect(hasFrameClass(assistant)).toBe(false);
    expect(hasFrameClass(content)).toBe(false);
  });

  it("shows the MOZI avatar beside assistant messages", () => {
    renderWithLocale(<MessageBubble message={message("assistant", "Done.")} />);

    expect(screen.getByTestId("mozi-avatar")).toBeInTheDocument();
  });

  it("does not render an empty non-streaming assistant bubble", () => {
    const { container } = renderWithLocale(<MessageBubble message={message("assistant", " \n\n\t ")} />);

    expect(screen.queryByTestId("message-assistant")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the assistant typing placeholder for an empty live stream", () => {
    renderWithLocale(
      <MessageBubble
        message={{
          ...message("assistant", " \n\n "),
          streaming: true,
          requestId: "req-typing",
        }}
      />,
    );

    expect(screen.getByTestId("message-assistant")).toBeInTheDocument();
    expect(screen.getByTestId("mozi-avatar")).toBeInTheDocument();
  });

  it("uses the Lobe chat reading surface on the shared assistant content axis", () => {
    renderWithLocale(<MessageBubble message={message("assistant", "# 核心结论\n\n正文内容。")} />);

    expect(screen.getByTestId("message-assistant")).toHaveClass("w-full", "max-w-full");
    expect(screen.getByTestId("message-assistant").className).not.toContain("translate-x");
    expect(screen.getByTestId("message-assistant-content")).toHaveAttribute(
      "data-markdown-reading-surface",
      "answer",
    );
    expect(screen.getByTestId("message-assistant-content")).toHaveClass("text-[14px]", "leading-[1.6]");
  });

  it("does not show an avatar on user messages", () => {
    renderWithLocale(<MessageBubble message={message("user", "Hi")} />);

    expect(screen.queryByTestId("mozi-avatar")).not.toBeInTheDocument();
  });

  it("keeps user output as the only chat bubble", () => {
    renderWithLocale(<MessageBubble message={message("user", "Run the investigation.")} />);

    const bubble = screen.getByTestId("message-user-bubble");

    expect(bubble).toHaveTextContent("Run the investigation.");
    expect(bubble.className).toContain("bg-selection/15");
    expect(bubble.className).toContain("rounded-2xl");
  });

  it("copies message text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    renderWithLocale(<MessageBubble message={message("assistant", "The answer is 42.")} />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    // Rich copy renders HTML via a dynamic import first, so the write is async.
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("The answer is 42."));
    // Transient feedback flips the label to "Copied".
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());

    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it("falls back to execCommand and still confirms when the async clipboard is unavailable", async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    // Reproduce the reported "dead button": no async Clipboard API present.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const execCommand = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof execCommand }).execCommand = execCommand;

    renderWithLocale(<MessageBubble message={message("assistant", "The answer is 42.")} />, { locale: "en" });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument());

    if (original) Object.defineProperty(navigator, "clipboard", original);
    else delete (navigator as unknown as Record<string, unknown>).clipboard;
  });

  it("regenerates a user message by re-sending its exact content", () => {
    const onRegenerate = vi.fn();
    renderWithLocale(<MessageBubble message={message("user", "Draft the plan.")} onRegenerate={onRegenerate} />);

    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("Draft the plan.");
  });

  it("regenerates an assistant answer by re-running its source prompt", () => {
    const onRegenerate = vi.fn();
    renderWithLocale(
      <MessageBubble message={message("assistant", "The answer.")} onRegenerate={onRegenerate} regenerateText="original question" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("original question");
  });

  it("offers a labeled delete action for a persisted message", () => {
    const onDelete = vi.fn();
    renderWithLocale(
      <MessageBubble
        message={{ ...message("assistant", "Delete me."), id: "conversation:42" }}
        onDelete={onDelete}
      />,
      { locale: "en" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete message" }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: "conversation:42" }));
  });

  it("does not offer regenerate on an assistant message with no source prompt", () => {
    renderWithLocale(<MessageBubble message={message("assistant", "Done.")} onRegenerate={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it("renders assistant narration without actions in the quieter interim style", () => {
    renderWithLocale(
      <MessageBubble
        message={message("assistant", "I will check the environment first.")}
        onRegenerate={vi.fn()}
        regenerateText="original question"
        showAssistantActions={false}
      />,
      { locale: "en" },
    );

    const content = screen.getByTestId("message-assistant-content");

    expect(content).toHaveTextContent("I will check the environment first.");
    expect(hasExactClass(content, "text-ink/70")).toBe(true);
    expect(content).not.toHaveAttribute("data-markdown-reading-surface");
    expect(screen.getByTestId("message-assistant")).toHaveClass("max-w-full");
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
  });

  it("renders assistant markdown links with external-safe rules", () => {
    renderWithLocale(
      <MessageBubble
        message={message(
          "assistant",
          [
            "[HTTP](https://example.com/report)",
            "[CodeBuddy](codebuddy.cn/work)",
            "[Local deck](/Users/x/a.pptx)",
            "[Filename](a.pptx)",
            "[Email](mailto:team@example.com)",
          ].join("\n\n"),
        )}
      />,
    );

    const http = screen.getByRole("link", { name: "HTTP" });
    expect(http).toHaveAttribute("href", "https://example.com/report");
    expect(http).toHaveAttribute("target", "_blank");
    expect(http).toHaveAttribute("rel", "noopener noreferrer nofollow");

    const bareDomain = screen.getByRole("link", { name: "CodeBuddy" });
    expect(bareDomain).toHaveAttribute("href", "https://codebuddy.cn/work");
    expect(bareDomain).toHaveAttribute("target", "_blank");

    const email = screen.getByRole("link", { name: "Email" });
    expect(email).toHaveAttribute("href", "mailto:team@example.com");
    expect(email).not.toHaveAttribute("target");

    expect(screen.queryByRole("link", { name: "Local deck" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Filename" })).not.toBeInTheDocument();
    expect(screen.getByText("Local deck")).toBeInTheDocument();
    expect(screen.getByText("Filename")).toBeInTheDocument();
  });

  it("renders an attachment chip on the user bubble when files are attached", () => {
    renderWithLocale(
      <MessageBubble
        message={{
          id: "user-att-1",
          role: "user",
          content: "分析这个文件",
          timestamp: 1,
          attachments: [{ filename: "ZAND_AI_Platform_Overview.pptx", path: "/data/workspace/users/u/deck.pptx" }],
        }}
      />,
    );
    const chips = screen.getByTestId("message-user-attachments");
    expect(chips).toHaveTextContent("ZAND_AI_Platform_Overview.pptx");
    expect(screen.getByTestId("message-user")).toHaveTextContent("分析这个文件");
  });

  it("renders attachment-only user messages (no text) without an empty bubble", () => {
    renderWithLocale(
      <MessageBubble
        message={{
          id: "user-att-2",
          role: "user",
          content: "",
          timestamp: 1,
          attachments: [{ filename: "data.xlsx", path: "/data/workspace/users/u/data.xlsx" }],
        }}
      />,
    );
    expect(screen.getByTestId("message-user-attachments")).toHaveTextContent("data.xlsx");
    expect(screen.queryByTestId("message-user-bubble")).toBeNull();
  });

});
