import { fireEvent, screen, renderWithLocale, within } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, ChatMessage, SessionState, TimelineItem, ToolEvent } from "@/types";
import ChatView from "./ChatView";

function message(
  role: ChatMessage["role"],
  content: string,
  timestamp: number,
  overrides: Partial<ChatMessage> = {},
): TimelineItem {
  return {
    type: "message",
    timestamp,
    data: {
      id: `${role}-${timestamp}`,
      role,
      content,
      timestamp,
      ...overrides,
    } satisfies ChatMessage,
  };
}

function toolEvent(
  callId: string,
  timestamp: number,
  turnId?: string,
  overrides: Partial<ToolEvent> = {},
): TimelineItem {
  return {
    type: "tool_event",
    timestamp,
    data: {
      id: `tool-${callId}`,
      callId,
      turnId,
      tool: "web_search",
      phase: "end",
      status: "success",
      intent: "Search the project",
      result: "Done",
      elapsed_ms: 9_000,
      timestamp,
      ...overrides,
    } satisfies ToolEvent,
  };
}

function artifactItem(timestamp: number, overrides: Partial<Artifact> = {}): TimelineItem {
  const artifact: Artifact = {
    id: overrides.id ?? `artifact-${timestamp}`,
    plugin_id: overrides.plugin_id,
    title: overrides.title ?? "Live deck",
    status: overrides.status ?? "completed",
    fallback_text: overrides.fallback_text,
    data: overrides.data ?? { content_type: "html" },
    timestamp: overrides.timestamp ?? timestamp,
  };
  return { type: "artifact", timestamp, data: artifact };
}

function hasExactClass(element: HTMLElement, className: string) {
  return element.className.split(/\s+/).includes(className);
}

function activityIndicatorCount() {
  return [
    ...screen.queryAllByTestId("chat-responding-status-line"),
    ...screen.queryAllByTestId("chat-active-tool-line"),
    ...screen.queryAllByTestId("chat-thinking-indicator"),
    ...screen.queryAllByTestId("execution-live-line"),
  ].length;
}

function renderChat(
  timeline: TimelineItem[],
  options: {
    sessionId?: string;
    sessionState?: SessionState;
    activeTool?: string | null;
    activeToolSkillName?: string | null;
    activeTurnId?: string | null;
    timelineCapabilities?: string[];
    turns?: import("@/types").TurnEnvelope[];
    onSend?: (content: string) => void;
    onRegenerate?: (content: string) => void;
    onOpenMemory?: () => void;
  } = {},
) {
  const onSend = options.onSend ?? vi.fn();
  const onRegenerate = options.onRegenerate ?? vi.fn();
  return renderWithLocale(
    <ChatView
      sessionId={options.sessionId}
      timeline={timeline}
      sessionState={options.sessionState ?? "IDLE"}
      activeTool={options.activeTool ?? null}
      activeToolSkillName={options.activeToolSkillName}
      activeTurnId={options.activeTurnId}
      timelineCapabilities={options.timelineCapabilities}
      turns={options.turns}
      onApprove={vi.fn()}
      onReject={vi.fn()}
      onSend={onSend}
      onRegenerate={onRegenerate}
      onOpenMemory={options.onOpenMemory}
    />,
  );
}

describe("ChatView", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("renders a restored memory update as a quiet action that opens Memory", () => {
    const onOpenMemory = vi.fn();
    renderChat([
      message("user", "Remember that I prefer concise replies", 1, { turnId: "turn-memory" }),
      {
        type: "memory_update",
        timestamp: 2,
        turnId: "turn-memory",
        seq: 2,
        data: {
          count: 1, added: 1, reinforced: 0, updated: 0,
          factIds: [41], timestamp: 2, turnId: "turn-memory", seq: 2,
        },
      },
    ], { onOpenMemory });

    fireEvent.click(screen.getByRole("button", { name: "Saved to memory. Open memory" }));
    expect(onOpenMemory).toHaveBeenCalledOnce();
  });

  it("places active conversation content inside the centered workspace reading rail", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", "Here is the report.", 2),
    ]);

    const scrollRegion = screen.getByTestId("chat-scroll-region");
    const rail = screen.getByTestId("chat-timeline-rail");

    expect(scrollRegion).toContainElement(rail);
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(rail.className).toContain("mx-auto");
    expect(rail.className).toContain("max-w-[960px]");
    expect(rail.className).toContain("px-4");
    expect(rail.className).not.toContain("lg:px-16");
    expect(screen.getByTestId("message-user")).toBeInTheDocument();
    expect(screen.getByTestId("message-assistant")).toBeInTheDocument();
  });

  it("pauses auto-follow when the user scrolls up and resumes from the latest button", () => {
    renderChat(
      [message("user", "Write a long answer", 1), message("assistant", "Streaming answer", 2, { streaming: true })],
      { sessionState: "RESPONDING" },
    );
    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 200 },
    });

    fireEvent.scroll(region);

    const jumpButton = screen.getByTestId("chat-jump-to-latest");
    expect(jumpButton).toHaveTextContent("MOZI is responding · Jump to latest");

    fireEvent.click(jumpButton);

    expect(region.scrollTo).toHaveBeenCalledWith({ top: 1200, behavior: "auto" });
    expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
  });

  it("resumes auto-follow when the user manually returns near the bottom", () => {
    renderChat([message("user", "Review this", 1), message("assistant", "Answer", 2)]);
    const region = screen.getByTestId("chat-scroll-region");
    Object.defineProperties(region, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 100 },
    });
    fireEvent.scroll(region);
    expect(screen.getByTestId("chat-jump-to-latest")).toHaveTextContent("Jump to latest");

    region.scrollTop = 665;
    fireEvent.scroll(region);

    expect(screen.queryByTestId("chat-jump-to-latest")).not.toBeInTheDocument();
  });

  it("shows the quiet empty state suggestions and sends their prompts", () => {
    const onSend = vi.fn();
    const onRegenerate = vi.fn();
    renderWithLocale(
      <ChatView
        timeline={[]}
        sessionState="IDLE"
        activeTool={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={onSend}
        onRegenerate={onRegenerate}
      />,
      { locale: "en" },
    );

    expect(screen.getByText("What are we doing today?")).toBeInTheDocument();
    expect(screen.getByText("Start with a task, a question, or something to build.")).toBeInTheDocument();
    expect(screen.getAllByText("↗")).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Research a topic for me" }));

    expect(onSend).toHaveBeenCalledWith("Research a topic for me");
    expect(onRegenerate).not.toHaveBeenCalled();
  });

  it("folds interim assistant text into one quiet disclosure and keeps a single avatar", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", "I will check.", 2),
      message("assistant", "Here is the report.", 3),
    ]);

    // Only the final answer stays full-size; the interim narration lives in the fold.
    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.getByText("Here is the report.")).toBeInTheDocument();
    expect(screen.queryByText("I will check.")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.getByTestId("mozi-avatar").querySelector("img")).toHaveAttribute("src", "/mozi-mark.png");

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    expect(screen.getByText("I will check.")).toBeInTheDocument();
  });

  it("shows an approximate minutes-only duration on the fold for long multi-phase work", () => {
    const t0 = 1_700_000_000_000;
    renderChat([
      { ...message("user", "梳理一下这个项目", 1), timestamp: t0 },
      { ...message("assistant", "先让我全面了解项目结构。", 2), timestamp: t0 + 1_000 },
      toolEvent("phase-1", t0 + 2_000, "turn-1", { timestamp: t0 + 2_000 }),
      { ...message("assistant", "继续查看架构文档。", 3), timestamp: t0 + 3_000 },
      toolEvent("phase-2", t0 + 435_000, "turn-1", { timestamp: t0 + 435_000 }),
      { ...message("assistant", "文档已经生成完毕。", 4), timestamp: t0 + 436_000 },
    ]);

    const summary = screen.getByTestId("turn-fold-summary");
    expect(summary.textContent).toContain("View work");
    expect(summary.textContent).toContain("about 7 min");
    expect(summary.textContent).not.toMatch(/milliseconds|ms|seconds/);
  });

  it("leaves no successful execution residue beside a simple final answer", () => {
    renderChat([
      message("user", "Research the models", 1),
      toolEvent("search-1", 2, "turn-1"),
      message("assistant", "Here is the final comparison.", 3),
    ]);

    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.getByTestId("mozi-avatar").querySelector(".animate-pulse")).toBeNull();
  });

  it("renders interim assistant turn fragments without actions and keeps the final answer actionable", () => {
    const onSend = vi.fn();
    const onRegenerate = vi.fn();
    renderChat(
      [
        message("user", "Make the app.", 1),
        message("assistant", "信息够了，我先检查环境。", 2),
        toolEvent("search-1", 3, "turn-1"),
        message("assistant", "好的，环境就绪。现在开始制作。", 4),
        toolEvent("build-1", 5, "turn-1"),
        message("assistant", "完成了，可以在本地查看。", 6),
      ],
      { onSend, onRegenerate },
    );

    // Interim fragments and their successful work fold; the answer stands alone.
    const assistantMessages = screen.getAllByTestId("message-assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
    expect(screen.queryByText("信息够了，我先检查环境。")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    const foldContent = screen.getByTestId("turn-fold-content");
    expect(within(foldContent).getAllByTestId("turn-fold-narration")).toHaveLength(2);
    for (const interim of within(foldContent).getAllByTestId("turn-fold-narration")) {
      expect(within(interim).queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
      expect(within(interim).queryByRole("button", { name: "Regenerate" })).not.toBeInTheDocument();
    }

    const finalMessage = assistantMessages[0];
    const finalContent = within(finalMessage).getByTestId("message-assistant-content");
    expect(hasExactClass(finalContent, "text-ink/70")).toBe(false);
    expect(within(finalMessage).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    fireEvent.click(within(finalMessage).getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("Make the app.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps one MOZI avatar across progress text, tools, artifacts, and the final answer", () => {
    renderChat([
      message("user", "Create a Word report.", 1),
      message("assistant", "I will inspect the project first.", 2),
      toolEvent("inspect-1", 3, "turn-1"),
      artifactItem(4, { title: "report.docx", plugin_id: "file_v1" }),
      message("assistant", "The report is ready.", 5),
    ]);

    // Narration and successful work fold; the deliverable artifact and the
    // final answer remain visible with one shared avatar.
    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.getByText("The report is ready.")).toBeInTheDocument();
    expect(screen.getByText("report.docx")).toBeInTheDocument();
    expect(screen.getByTestId("turn-fold-summary")).toBeInTheDocument();
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
  });

  it("hides persisted build metadata artifacts while keeping the user deliverable", () => {
    renderChat([
      message("user", "Create a Word report.", 1),
      artifactItem(2, {
        id: "build-metadata",
        title: "build_script_build-deadbeef.d",
        plugin_id: "file_v1",
        data: { filename: "build_script_build-deadbeef.d", path: "/project/target/debug/build_script_build-deadbeef.d" },
      }),
      artifactItem(3, {
        id: "generator",
        title: "generate_report.js",
        plugin_id: "file_v1",
        data: { filename: "generate_report.js", path: "/project/generate_report.js" },
      }),
      artifactItem(4, {
        id: "deliverable",
        title: "report.docx",
        plugin_id: "file_v1",
        data: { filename: "report.docx", path: "/project/report.docx" },
      }),
    ]);

    expect(screen.queryByText("build_script_build-deadbeef.d")).not.toBeInTheDocument();
    expect(screen.queryByText("generate_report.js")).not.toBeInTheDocument();
    expect(screen.getByText("report.docx")).toBeInTheDocument();
  });

  it("routes message regenerate actions through onRegenerate, not onSend", () => {
    const onSend = vi.fn();
    const onRegenerate = vi.fn();
    renderChat(
      [
        message("user", "Draft the plan.", 1),
        message("assistant", "Here is the plan.", 2),
      ],
      { onSend, onRegenerate },
    );

    fireEvent.click(within(screen.getByTestId("message-user")).getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledWith("Draft the plan.");
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId("message-assistant")).getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledTimes(2);
    expect(onRegenerate).toHaveBeenLastCalledWith("Draft the plan.");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps actions on a single assistant answer turn", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", "Here is the report.", 2),
    ]);

    const assistant = screen.getByTestId("message-assistant");

    expect(within(assistant).getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(within(assistant).getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  it("does not let an empty assistant message consume the turn avatar", () => {
    renderChat([
      message("user", "Research OpenClaw", 1),
      message("assistant", " \n\n ", 2),
      message("assistant", "Here is the report.", 3),
    ]);

    expect(screen.getAllByTestId("message-assistant")).toHaveLength(1);
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(1);
  });

  it("shows thinking while a turn is running before answer text exists", () => {
    renderChat([message("user", "Research OpenClaw", 1)], { sessionState: "WORKING" });

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.queryByText("Responding...")).not.toBeInTheDocument();
  });

  it("keeps a single working indicator as the sole status owner until the current turn terminalizes", () => {
    renderChat([
      message("user", "Inspect this project", 1),
      message("assistant", "I will inspect the project first.", 2),
      toolEvent("inspect-1", 3, "turn-1"),
    ], { sessionState: "WORKING", activeTurnId: "turn-1" });

    // The consolidated working capsule is the sole status owner once the turn
    // has execution activity (four-region model, 2026-07-18): no generic
    // thinking line, no per-block summary, exactly one spinner.
    expect(screen.getByTestId("execution-live-work")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-thinking-indicator")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".animate-spin")).toHaveLength(1);
    expect(screen.getByTestId("mozi-avatar").querySelector(".animate-pulse")).toBeNull();
  });

  it("anchors the working capsule at the top of the turn with narration streaming below", () => {
    renderChat([
      message("user", "Organize this project", 1, { turnId: "turn-1" }),
      message("assistant", "Let me inspect the structure first.", 2, { turnId: "turn-1" }),
      toolEvent("phase-1", 3, "turn-1"),
      message("assistant", "It is a Rust project. Reading core files.", 4, { turnId: "turn-1" }),
      toolEvent("phase-2", 5, "turn-1"),
      message("assistant", "Now generating the document.", 6, { turnId: "turn-1" }),
    ], { sessionState: "WORKING", activeTurnId: "turn-1" });

    // Four-region order (operator, 2026-07-18): user message → working
    // capsule → the answer/narration below it. The growing answer must not
    // push the capsule to the bottom.
    const capsule = screen.getByTestId("execution-live-work");
    const narration = screen.getByText("Now generating the document.");
    expect(capsule.compareDocumentPosition(narration) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const userMsg = screen.getByText("Organize this project");
    expect(userMsg.compareDocumentPosition(capsule) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No suppressed same-turn block resurfaces, and only one spinner exists.
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".animate-spin")).toHaveLength(1);
  });

  it("does not show fallback thinking while a current-turn artifact is running", () => {
    renderChat(
      [
        message("user", "Create a deck", 1),
        artifactItem(2, {
          plugin_id: "live_work_v1",
          status: "running",
          data: { content_type: "html", live_preview: true, phase: "writing" },
        }),
      ],
      { sessionState: "WORKING" },
    );

    expect(screen.getByText("Generating")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText("Responding...")).not.toBeInTheDocument();
  });

  it("shows fallback thinking after a current-turn artifact completes while the turn is still working", () => {
    renderChat(
      [
        message("user", "Create a deck", 1),
        artifactItem(2, {
          plugin_id: "live_work_v1",
          status: "completed",
          data: { content_type: "html", live_preview: true, phase: "writing" },
        }),
      ],
      { sessionState: "WORKING" },
    );

    expect(screen.getByText("Working...")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
  });

  it("does not show an extra indicator when the last item is visible streaming assistant text", () => {
    renderChat(
      [
        message("user", "Research OpenClaw", 1),
        message("assistant", "Partial answer", 2, { streaming: true, requestId: "req-1" }),
      ],
      { sessionState: "RESPONDING" },
    );

    expect(screen.queryByTestId("chat-responding-status-line")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-thinking-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
  });

  it("shows responding while a streaming assistant message has no visible content yet", () => {
    renderChat(
      [
        message("user", "Research OpenClaw", 1),
        message("assistant", "", 2, { streaming: true, requestId: "req-1" }),
      ],
      { sessionState: "RESPONDING" },
    );

    expect(screen.getByTestId("chat-responding-status-line")).toHaveTextContent("Responding...");
    expect(screen.queryByTestId("chat-thinking-indicator")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
  });

  it("renders at most one extra activity indicator across representative states", () => {
    const cases: Array<{
      name: string;
      timeline: TimelineItem[];
      sessionState: SessionState;
      activeTool?: string | null;
    }> = [
      {
        name: "idle",
        timeline: [message("user", "Research OpenClaw", 1)],
        sessionState: "IDLE",
      },
      {
        name: "thinking",
        timeline: [message("user", "Research OpenClaw", 1)],
        sessionState: "WORKING",
      },
      {
        name: "tool active",
        timeline: [message("user", "Search the web", 1)],
        sessionState: "WORKING",
        activeTool: "web_search",
      },
      {
        name: "streaming with content",
        timeline: [
          message("user", "Research OpenClaw", 1),
          message("assistant", "Partial answer", 2, { streaming: true, requestId: "req-1" }),
        ],
        sessionState: "RESPONDING",
      },
      {
        name: "streaming empty",
        timeline: [
          message("user", "Research OpenClaw", 1),
          message("assistant", "", 2, { streaming: true, requestId: "req-1" }),
        ],
        sessionState: "RESPONDING",
      },
      {
        name: "running artifact",
        timeline: [
          message("user", "Create a deck", 1),
          artifactItem(2, {
            plugin_id: "live_work_v1",
            status: "running",
            data: { content_type: "html", live_preview: true, phase: "writing" },
          }),
        ],
        sessionState: "WORKING",
      },
    ];

    for (const activityCase of cases) {
      const { unmount } = renderChat(activityCase.timeline, {
        sessionState: activityCase.sessionState,
        activeTool: activityCase.activeTool,
      });

      expect(activityIndicatorCount(), activityCase.name).toBeLessThanOrEqual(1);
      unmount();
    }
  });

  it("shows the active tool label instead of thinking or responding", () => {
    renderChat([message("user", "Search the web", 1)], {
      sessionState: "WORKING",
      activeTool: "web_search",
    });

    expect(screen.getByText("Searching public information")).toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText("Responding...")).not.toBeInTheDocument();
  });

  it("keeps the live running tool event visible near the bottom without adding a duplicate indicator", () => {
    renderChat(
      [
        message("user", "Search the web", 1),
        toolEvent("search-1", 2, "turn-1", { phase: "start", status: undefined }),
      ],
      { sessionState: "WORKING", activeTurnId: "turn-1" },
    );

    // The working capsule owns liveness; no extra indicator of any kind.
    expect(screen.getByTestId("execution-live-work")).toHaveTextContent("Search the project");
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(activityIndicatorCount()).toBe(0);
  });

  it("keeps a background running tool live when the foreground session is idle", () => {
    const timeline = [
      message("user", "Search the web", 1),
      toolEvent("search-1", 2, "turn-1", { phase: "start", status: undefined }),
    ];
    const { rerender } = renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="WORKING"
        activeTool={null}
        activeTurnId="turn-1"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
      { locale: "en" },
    );

    expect(screen.getByTestId("execution-live-work")).toHaveTextContent("Search the project");

    rerender(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        activeTurnId={null}
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
    );

    expect(screen.getByTestId("execution-live-work")).toHaveTextContent("Search the project");
    expect(screen.queryByTestId("chat-active-tool-line")).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    expect(screen.queryByText(/runtime restarted/i)).not.toBeInTheDocument();
  });

  it("names the loading skill in the live line", () => {
    renderWithLocale(
      <ChatView
        timeline={[message("user", "使用 imagegen", 1)]}
        sessionState="WORKING"
        activeTool="use_skill"
        activeToolSkillName="imagegen"
        onApprove={vi.fn()}
        onReject={vi.fn()}
        onSend={vi.fn()}
        onRegenerate={vi.fn()}
      />,
      { locale: "en" },
    );

    // The skill name is runtime truth the user asked to see (operator,
    // 2026-07-18): "Loading skill imagegen", never a nameless verb.
    expect(screen.getByTestId("chat-active-tool-line")).toHaveTextContent("Loading skill imagegen");
  });
});

describe("ChatView deterministic turn projection (Issue #625)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.scrollTo = vi.fn();
  });

  const CAPS = ["timeline_v1"];

  function idMessage(role: ChatMessage["role"], content: string, turnId: string, seq: number): TimelineItem {
    return {
      type: "message",
      timestamp: 1000 + seq,
      turnId,
      seq,
      data: { id: `${role}-${turnId}-${seq}`, role, content, timestamp: 1000 + seq, turnId, seq },
    };
  }

  function idTool(turnId: string, callId: string, seq: number, overrides: Partial<ToolEvent> = {}): TimelineItem {
    return {
      type: "tool_event",
      timestamp: 1000 + seq,
      turnId,
      seq,
      data: {
        id: `tool-${callId}`,
        callId,
        turnId,
        seq,
        tool: "web_search",
        phase: "end",
        status: "success",
        intent: "Search the project",
        result: "Done",
        elapsed_ms: 9_000,
        timestamp: 1000 + seq,
        ...overrides,
      } satisfies ToolEvent,
    };
  }

  it("renders exactly one MOZI avatar per turn", () => {
    renderChat(
      [
        idMessage("user", "first question", "turn_1000", 1),
        idTool("turn_1000", "c1", 2, { status: "error", error: "boom", elapsed_ms: 9_000 }),
        idMessage("assistant", "first answer", "turn_1000", 3),
        idMessage("user", "second question", "turn_2000", 1),
        idTool("turn_2000", "c2", 2, { status: "error", error: "bang", elapsed_ms: 9_000 }),
        idMessage("assistant", "second answer", "turn_2000", 3),
      ],
      { timelineCapabilities: CAPS },
    );

    // One avatar per turn — not one per assistant row.
    expect(screen.getAllByTestId("mozi-avatar")).toHaveLength(2);
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("second answer")).toBeInTheDocument();
  });

  it("renders a pre-answer failure before the answer (true chronology)", () => {
    renderChat(
      [
        idMessage("user", "do it", "turn_1", 1),
        idTool("turn_1", "c1", 2, { status: "error", error: "denied", elapsed_ms: 9_000 }),
        idMessage("assistant", "here is the result", "turn_1", 3),
      ],
      { timelineCapabilities: CAPS },
    );

    const rail = screen.getByTestId("chat-timeline-rail");
    // The survived failure folds into the turn fold, which precedes the answer.
    // A mid-turn error the turn moved past is normal process, so the completed
    // turn still reads as done (green), not as a failure.
    const foldSummary = within(rail).getByTestId("turn-fold-summary");
    expect(within(rail).getByTestId("turn-fold-done-dot")).toBeInTheDocument();
    expect(within(rail).queryByTestId("turn-fold-issue-dot")).not.toBeInTheDocument();
    const answer = within(rail).getByText("here is the result");
    expect(foldSummary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(foldSummary);
    expect(within(screen.getByTestId("turn-fold-content")).getByTestId("execution-block-embedded")).toBeInTheDocument();
  });

  it("keeps a hard-failed turn out of the fold with neutral collapsed process details", () => {
    // Envelope truth: the TURN terminally failed. Its process must own its
    // surface while the final assistant message reports the failure. Process
    // details remain available without opening themselves automatically.
    renderChat(
      [
        idMessage("user", "do it", "turn_f1", 1),
        idTool("turn_f1", "c1", 2, { status: "error", error: "denied", elapsed_ms: 9_000 }),
        idMessage("assistant", "I could not finish this.", "turn_f1", 3),
      ],
      {
        timelineCapabilities: CAPS,
        turns: [{ turnId: "turn_f1", sessionId: "s", chatId: "c", origin: "user", status: "failed", seqHighWater: 3, startedAt: 1, locale: "en" }],
      },
    );

    expect(screen.queryByTestId("turn-fold-summary")).not.toBeInTheDocument();
    expect(screen.getByTestId("execution-block")).toBeInTheDocument();
    expect(screen.getByTestId("execution-summary")).toHaveTextContent("View work");
    expect(screen.getByTestId("execution-summary")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("execution-timeline")).not.toBeInTheDocument();
    expect(screen.getByText("I could not finish this.")).toBeInTheDocument();
  });

  it("renders one consolidated error capsule when narration splits a hard-failed turn", () => {
    const repeatedError = "Traceback (most recent call last): generator failed";
    renderChat(
      [
        idMessage("user", "build the report", "turn_f2", 1),
        idTool("turn_f2", "c1", 2, { status: "error", error: repeatedError, elapsed_ms: 1_000 }),
        idMessage("assistant", "The first attempt failed; I am repairing it.", "turn_f2", 3),
        idTool("turn_f2", "read", 4, { tool: "read_file", intent: "/tmp/report.py", elapsed_ms: 100 }),
        idTool("turn_f2", "c2", 5, { status: "error", error: repeatedError, elapsed_ms: 1_000 }),
        idMessage("assistant", "I could not complete verification.", "turn_f2", 6),
      ],
      {
        timelineCapabilities: CAPS,
        turns: [{ turnId: "turn_f2", sessionId: "s", chatId: "c", origin: "user", status: "failed", seqHighWater: 6, startedAt: 1, locale: "en" }],
      },
    );

    expect(screen.queryByTestId("turn-fold-summary")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("execution-block")).toHaveLength(1);
    expect(screen.getAllByTestId("execution-summary")).toHaveLength(1);
    expect(screen.getByTestId("execution-summary")).toHaveTextContent("View work");
    expect(screen.queryByTestId("execution-timeline")).not.toBeInTheDocument();
    expect(screen.getByText("I could not complete verification.")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("execution-summary"));

    expect(screen.getAllByTestId("execution-timeline")).toHaveLength(1);
    expect(screen.getAllByTestId("execution-technical-summary")).toHaveLength(1);
    expect(screen.getByText(/Command reported errors \(repeated 2 times\)/)).toBeInTheDocument();
  });

  it("still folds a survived mid-turn error when the turn envelope completed", () => {
    renderChat(
      [
        idMessage("user", "do it", "turn_s1", 1),
        idTool("turn_s1", "c1", 2, { status: "error", error: "denied", elapsed_ms: 9_000 }),
        idMessage("assistant", "here is the result", "turn_s1", 3),
      ],
      {
        timelineCapabilities: CAPS,
        turns: [{ turnId: "turn_s1", sessionId: "s", chatId: "c", origin: "user", status: "completed", seqHighWater: 3, startedAt: 1, locale: "en" }],
      },
    );

    expect(screen.getByTestId("turn-fold-summary")).toBeInTheDocument();
    expect(screen.queryByTestId("execution-block")).not.toBeInTheDocument();
  });

  it("renders one process fold for a scheduled plan spanning trigger, execution, and message turns", () => {
    const rootTaskId = "502eca4a-root";
    const executionTurnId = `turn_bg_${rootTaskId}`;
    const messageTurnId = "turn_bg_1784739657334_message";
    const timeline: TimelineItem[] = [
      idMessage("user", "生成本周投资简报", "turn_1784739105273_trigger", 0),
      {
        type: "plan_started", timestamp: 1001, turnId: "turn_1784739105273_trigger", seq: 1,
        data: {
          plan_id: rootTaskId,
          goal: "生成本周投资简报",
          phases: [{ taskId: "step-research", title: "收集市场数据", dependsOn: [] }],
          timestamp: 1001,
          turnId: "turn_1784739105273_trigger",
          seq: 1,
        },
      },
      idTool("turn_1784739105273_trigger", "admit-plan", 2),
      {
        type: "task_update", timestamp: 1003, turnId: executionTurnId, seq: 1,
        data: {
          id: "step-research-complete", task_id: "step-research", title: "收集市场数据",
          status: "completed", detail: "已汇总指数与市场数据", timestamp: 1003,
          turnId: executionTurnId, seq: 1,
        },
      },
      idTool(executionTurnId, "write-report", 2, { taskId: "step-research", tool: "file_write" }),
      {
        type: "artifact", timestamp: 1005, turnId: executionTurnId, seq: 3,
        data: { id: "notes", plugin_id: "document_v1", title: "研究底稿", status: "completed", data: { role: "workspace", markdown: "notes" }, timestamp: 1005, turnId: executionTurnId },
      },
      {
        type: "artifact", timestamp: 1006, turnId: executionTurnId, seq: 4,
        data: { id: "report", plugin_id: "file_v1", title: "投资简报.pdf", status: "completed", data: { role: "primary", path: "/output/report.pdf", filename: "report.pdf", ext: "pdf", size: 1024 }, timestamp: 1006, turnId: executionTurnId },
      },
      idMessage("assistant", "投资简报已经完成。", messageTurnId, 1),
    ];
    renderChat(timeline, {
      timelineCapabilities: CAPS,
      // Reproduce the live ordering gap: the separately delivered message turn
      // is known before the stable plan execution envelope reaches the client.
      turns: [
        { turnId: "turn_1784739105273_trigger", sessionId: "s", chatId: "c", origin: "scheduler", status: "completed", seqHighWater: 2, startedAt: 100 },
        { turnId: messageTurnId, sessionId: "s", chatId: "c", origin: "background", status: "completed", seqHighWater: 1, startedAt: 200 },
      ],
    });

    expect(screen.getAllByTestId("turn-fold-summary")).toHaveLength(1);
    expect(screen.queryByTestId("execution-summary")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    const fold = screen.getByTestId("turn-fold-content");
    expect(within(fold).getByText("收集市场数据")).toBeInTheDocument();
    expect(within(fold).getByTestId("chat-view-all-artifacts")).toHaveTextContent("View all artifacts (2)");
    expect(within(fold).getByTestId("execution-technical-summary")).toBeInTheDocument();
  });

  it("keeps legacy (uncapable) sessions on the frozen renderer", () => {
    // No capability advertised → frozen path; still renders the conversation.
    renderChat(
      [
        message("user", "legacy question", 1),
        message("assistant", "legacy answer", 2),
      ],
      {},
    );
    expect(screen.getByText("legacy question")).toBeInTheDocument();
    expect(screen.getByText("legacy answer")).toBeInTheDocument();
  });

  // ── Issue #628: accessibility, keyboard navigation, windowing, EN/ZH parity ──

  describe("accessible live status (Issue #628)", () => {
    it("exposes a single polite live region", () => {
      renderChat([message("user", "hi", 1), message("assistant", "hello", 2)]);
      const live = screen.getByTestId("chat-live-status");
      expect(live).toHaveAttribute("role", "status");
      expect(live).toHaveAttribute("aria-live", "polite");
      // Idle session announces nothing (no chatter for a settled conversation).
      expect(live).toHaveTextContent("");
    });

    it("announces one coarse activity phase in the selected display language", () => {
      // A streaming assistant message with no renderable content yet → the
      // "responding" phase (before any answer text appears).
      const en = renderChat(
        [message("user", "hi", 1), message("assistant", "", 2, { streaming: true, requestId: "r1", turnId: "turn_1" })],
        { sessionState: "RESPONDING", timelineCapabilities: ["timeline_v1"], turns: [{ turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "active", seqHighWater: 2, startedAt: 1, locale: "en" }] },
      );
      expect(screen.getByTestId("chat-live-status")).toHaveTextContent("MOZI is responding");
      en.unmount();

      // A Chinese turn must not override the user's English display language.
      renderChat(
        [message("user", "你好", 1), message("assistant", "", 2, { streaming: true, requestId: "r1", turnId: "turn_1" })],
        { sessionState: "RESPONDING", timelineCapabilities: ["timeline_v1"], turns: [{ turnId: "turn_1", sessionId: "s", chatId: "c", origin: "user", status: "active", seqHighWater: 2, startedAt: 1, locale: "zh-CN" }] },
      );
      expect(screen.getByTestId("chat-live-status")).toHaveTextContent("MOZI is responding");
    });

    function approvalRequest(status: "pending" | "approved" | "rejected"): TimelineItem {
      return {
        type: "approval_request",
        timestamp: 2,
        data: { id: "ap1", description: "Delete files?", status, timestamp: 2 } as never,
      };
    }

    it("announces a pending approval as the meaningful activity", () => {
      renderChat([message("user", "delete it", 1), approvalRequest("pending")], { sessionState: "WORKING" });
      expect(screen.getByTestId("chat-live-status")).toHaveTextContent("MOZI is waiting for your approval");
    });

    it("stops announcing waiting once the approval card is approved", () => {
      // After resolution the card is still the last render item, but the live
      // region must fall back to the session's real activity — not linger on
      // "waiting for your approval" (Issue #628).
      renderChat([message("user", "delete it", 1), approvalRequest("approved")], { sessionState: "IDLE" });
      const live = screen.getByTestId("chat-live-status");
      expect(live).not.toHaveTextContent("waiting for your approval");
      expect(live).toHaveTextContent("");
    });

    it("stops announcing waiting once the approval card is rejected", () => {
      renderChat([message("user", "delete it", 1), approvalRequest("rejected")], { sessionState: "IDLE" });
      const live = screen.getByTestId("chat-live-status");
      expect(live).not.toHaveTextContent("waiting for your approval");
      expect(live).toHaveTextContent("");
    });
  });

  describe("keyboard navigation (Issue #628)", () => {
    it("moves focus between timeline rows with Arrow keys and Home/End", () => {
      renderChat([
        message("user", "one", 1),
        message("assistant", "first answer", 2),
        message("user", "two", 3),
        message("assistant", "second answer", 4),
      ]);
      const rail = screen.getByTestId("chat-timeline-rail");
      expect(rail).toHaveAttribute("role", "feed");
      const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-chat-row]"));
      expect(rows.length).toBeGreaterThanOrEqual(4);

      fireEvent.keyDown(rail, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows[0]);
      fireEvent.keyDown(rail, { key: "ArrowDown" });
      expect(document.activeElement).toBe(rows[1]);
      fireEvent.keyDown(rail, { key: "ArrowUp" });
      expect(document.activeElement).toBe(rows[0]);
      fireEvent.keyDown(rail, { key: "End" });
      expect(document.activeElement).toBe(rows[rows.length - 1]);
      fireEvent.keyDown(rail, { key: "Home" });
      expect(document.activeElement).toBe(rows[0]);
    });

    it("does not hijack navigation keys from controls inside a timeline row", () => {
      renderChat([message("user", "one", 1), message("assistant", "answer", 2)]);
      const copy = screen.getAllByRole("button", { name: "Copy" })[0];
      copy.focus();
      fireEvent.keyDown(copy, { key: "Home" });
      expect(document.activeElement).toBe(copy);
    });
  });

  describe("long-session windowing (Issue #628)", () => {
    function longTimeline(turnCount: number): TimelineItem[] {
      const items: TimelineItem[] = [];
      let ts = 0;
      for (let i = 0; i < turnCount; i++) {
        items.push(message("user", `question ${i}`, ++ts));
        items.push(message("assistant", `answer ${i}`, ++ts));
      }
      return items;
    }

    it("windows out the earlier prefix past the cap and reveals it on demand", () => {
      // 120 turns → 240 render rows, well past the 160-row cap.
      renderChat(longTimeline(120));
      // Earliest turn is hidden; a boundary-aligned prefix is collapsed.
      expect(screen.queryByText("question 0")).not.toBeInTheDocument();
      const showEarlier = screen.getByTestId("chat-show-earlier");
      expect(showEarlier).toHaveTextContent(/Show \d+ earlier messages/);
      // The most recent turn is always mounted (chronology preserved at the tail).
      expect(screen.getByText("answer 119")).toBeInTheDocument();

      fireEvent.click(showEarlier);
      expect(screen.getByText("question 0")).toBeInTheDocument();
      expect(screen.queryByTestId("chat-show-earlier")).not.toBeInTheDocument();
    });

    it("does not window a normal-length session", () => {
      renderChat(longTimeline(10));
      expect(screen.queryByTestId("chat-show-earlier")).not.toBeInTheDocument();
      expect(screen.getByText("question 0")).toBeInTheDocument();
    });

    it("resets an expanded history window when switching between two long sessions", () => {
      const first = longTimeline(120);
      const second = longTimeline(121).map((item) => item.type === "message"
        ? { ...item, data: { ...(item.data as ChatMessage), content: `B ${(item.data as ChatMessage).content}` } }
        : item);
      const { rerender } = renderChat(first, { sessionId: "session-a" });
      fireEvent.click(screen.getByTestId("chat-show-earlier"));
      expect(screen.getByText("question 0")).toBeInTheDocument();

      rerender(
        <ChatView
          sessionId="session-b"
          timeline={second}
          sessionState="IDLE"
          activeTool={null}
          onApprove={vi.fn()}
          onReject={vi.fn()}
          onSend={vi.fn()}
          onRegenerate={vi.fn()}
        />,
      );
      expect(screen.queryByText("B question 0")).not.toBeInTheDocument();
      expect(screen.getByTestId("chat-show-earlier")).toBeInTheDocument();
    });

    it("keeps the mounted DOM bounded for 500 authoritative turns, including background turns", () => {
      const timeline: TimelineItem[] = [];
      const turns: import("@/types").TurnEnvelope[] = [];
      for (let i = 0; i < 500; i++) {
        const turnId = `turn_bg_${i}`;
        timeline.push(message("assistant", `background result ${i}`, i + 1, { turnId, seq: 1 }));
        turns.push({
          turnId, sessionId: "long-session", chatId: "c", origin: "background",
          status: "completed", seqHighWater: 1, startedAt: i + 1, locale: i % 2 ? "en" : "zh-CN",
        });
      }
      const started = performance.now();
      renderChat(timeline, {
        sessionId: "long-session", timelineCapabilities: ["timeline_v1"], turns,
      });
      const elapsed = performance.now() - started;
      expect(document.querySelectorAll("[data-chat-row]").length).toBeLessThanOrEqual(161);
      expect(screen.getByText("background result 499")).toBeInTheDocument();
      // Generous jsdom budget: catches accidental all-500 DOM mounting while
      // remaining stable on slower CI machines. Pure projection has its tighter
      // 120 ms median budget in turn-projection.perf.test.ts.
      expect(elapsed).toBeLessThan(1_500);
    });

    it("transitions from the empty welcome state to a conversation without a hook-count error", () => {
      // Guards the rules-of-hooks ordering: the memoization/windowing hooks must
      // run before the empty-state early return, or this transition would throw
      // "rendered more hooks than during the previous render".
      const { rerender } = renderChat([], { sessionState: "IDLE" });
      // Welcome (empty) state took the early return — no timeline rail yet.
      expect(screen.queryByTestId("chat-timeline-rail")).not.toBeInTheDocument();
      expect(() =>
        rerender(
          <ChatView
            timeline={[message("user", "first question", 1), message("assistant", "first answer", 2)]}
            sessionState="IDLE"
            activeTool={null}
            onApprove={vi.fn()}
            onReject={vi.fn()}
            onSend={vi.fn()}
            onRegenerate={vi.fn()}
          />,
        ),
      ).not.toThrow();
      expect(screen.getByText("first answer")).toBeInTheDocument();
    });
  });

  describe("supporting files", () => {
    const fileArtifact = (ts: number, filename: string, role?: "primary" | "supporting") =>
      artifactItem(ts, {
        id: `file-${filename}`,
        title: filename,
        plugin_id: "file_v1",
        data: { filename, path: `/Users/me/.mozi/output/${filename}`, role },
      });

    it("collapses co-produced charts behind the deliverable instead of listing them as siblings", () => {
      // The production case: a report plus the charts embedded in it. The user
      // asked for the report, so five sibling chart cards bury the deliverable.
      renderChat([
        message("user", "做一份美债宏观报告", 1),
        fileArtifact(2, "US_Macro_Bond_Report_20260715.pdf", "primary"),
        fileArtifact(3, "chart1_yield_curve.png", "supporting"),
        fileArtifact(4, "chart2_scenario_impact.png", "supporting"),
        fileArtifact(5, "chart3_duration_convexity.png", "supporting"),
        message("assistant", "PDF 报告已生成。", 6),
      ]);

      expect(screen.getByText("US_Macro_Bond_Report_20260715.pdf")).toBeInTheDocument();
      expect(screen.queryByText("chart1_yield_curve.png")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /3 supporting files/i })).toBeInTheDocument();
    });

    it("keeps supporting files reachable rather than dropping them", () => {
      renderChat([
        message("user", "做一份美债宏观报告", 1),
        fileArtifact(2, "US_Macro_Bond_Report_20260715.pdf", "primary"),
        fileArtifact(3, "chart1_yield_curve.png", "supporting"),
        fileArtifact(4, "chart2_scenario_impact.png", "supporting"),
      ]);

      fireEvent.click(screen.getByRole("button", { name: /2 supporting files/i }));

      expect(screen.getByText("chart1_yield_curve.png")).toBeInTheDocument();
      expect(screen.getByText("chart2_scenario_impact.png")).toBeInTheDocument();
    });

    it("merges one turn's files across invisible suppressed rows (four-fragment regression)", () => {
      // The production incident (2026-07-19): workspace notes and other
      // render-null rows sat between a turn's supporting files, and the old
      // adjacency-based run shattered 67 files into four fragments. Grouping
      // is by turn identity now — invisible rows must not split the group.
      const turnFile = (ts: number, filename: string): TimelineItem => ({
        ...fileArtifact(ts, filename, "supporting"),
        turnId: "t-g",
      });
      const invisibleWorkspaceNote: TimelineItem = {
        type: "artifact",
        timestamp: 4,
        turnId: "t-g",
        data: {
          id: "ws-1", plugin_id: "document_v1", title: "步骤底稿", status: "completed",
          data: { markdown: "# note", role: "workspace" }, timestamp: 4, turnId: "t-g",
        } as Artifact,
      };
      renderChat(
        [
          { ...message("user", "分析数据", 1), turnId: "t-g" },
          { ...fileArtifact(2, "report.pdf", "primary"), turnId: "t-g" },
          turnFile(3, "chart_a.png"),
          invisibleWorkspaceNote,
          turnFile(5, "chart_b.png"),
          turnFile(6, "chart_c.png"),
          { ...message("assistant", "完成。", 7), turnId: "t-g" },
        ],
        { turns: [{ turnId: "t-g", status: "completed" }] as import("@/types").TurnEnvelope[] },
      );
      // ONE merged group, not fragments split by the invisible workspace row.
      expect(screen.getByRole("button", { name: /3 supporting files/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^1 supporting file/i })).not.toBeInTheDocument();
    });

    it("leaves files alone when the turn produced no deliverable to collapse behind", () => {
      // Charts may be the actual request; nothing should be hidden then.
      renderChat([
        message("user", "画三张图", 1),
        fileArtifact(2, "chart1_yield_curve.png"),
        fileArtifact(3, "chart2_scenario_impact.png"),
      ]);

      expect(screen.getByText("chart1_yield_curve.png")).toBeInTheDocument();
      expect(screen.getByText("chart2_scenario_impact.png")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /supporting file/i })).not.toBeInTheDocument();
    });
  });
});

describe("one technical details per turn fold", () => {
  it("renders a single merged Technical details even when narration splits the turn into blocks", () => {
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "修一下", timestamp: 1, turnId: "turn-td" } as ChatMessage },
      { type: "tool_event", timestamp: 2, data: { id: "t1", callId: "t1", turnId: "turn-td", seq: 1, tool: "file_read", phase: "end", status: "success", intent: '{"path":"/x/a.json"}', elapsed_ms: 100, timestamp: 2 } },
      { type: "message", timestamp: 3, data: { id: "a1", role: "assistant", content: "看完了，继续改。", timestamp: 3, turnId: "turn-td", seq: 2 } as ChatMessage },
      { type: "tool_event", timestamp: 4, data: { id: "t2", callId: "t2", turnId: "turn-td", seq: 3, tool: "shell_exec", phase: "end", status: "success", intent: "python gen_pdf.py", elapsed_ms: 100, timestamp: 4 } },
      { type: "message", timestamp: 5, data: { id: "a2", role: "assistant", content: "搞定，PDF 已生成。", timestamp: 5, turnId: "turn-td", seq: 4 } as ChatMessage },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        turns={[{ turnId: "turn-td", status: "completed" }] as TurnEnvelope[]}
      />,
    );

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    expect(screen.getAllByTestId("execution-technical-summary")).toHaveLength(1);
  });
});

describe("single stable live plan surface", () => {
  it("renders exactly one consolidated plan card for the active turn — no per-block fragments, no extra live line", () => {
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-live" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-live", seq: 1, data: { plan_id: "p1", goal: "Weekly review", phases: [{ taskId: "d1", title: "Research indices", dependsOn: [] }, { taskId: "d2", title: "Write summary", dependsOn: ["d1"] }], timestamp: 2, turnId: "t-live", seq: 1 } },
      { type: "task_update", timestamp: 3, turnId: "t-live", seq: 2, data: { id: "h1", task_id: "dag-root", title: "Plan", status: "completed", rawStatus: "dag_created", timestamp: 3, turnId: "t-live", seq: 2 } },
      { type: "message", timestamp: 4, data: { id: "a1", role: "assistant", content: "I broke this into a plan.", timestamp: 4, turnId: "t-live", seq: 3 } as ChatMessage },
      { type: "task_update", timestamp: 5, turnId: "t-live", seq: 4, data: { id: "ev-d1", task_id: "d1", title: "Research indices", status: "running", timestamp: 5, turnId: "t-live", seq: 4 } },
      { type: "tool_event", timestamp: 6, turnId: "t-live", seq: 5, data: { id: "w1", callId: "w1", taskId: "d1", turnId: "t-live", seq: 5, tool: "web_search", phase: "start", intent: "Nikkei weekly", timestamp: 6 } },
      { type: "message", timestamp: 7, data: { id: "a2", role: "assistant", content: "Got index data, moving on.", timestamp: 7, turnId: "t-live", seq: 6 } as ChatMessage },
      { type: "tool_event", timestamp: 8, turnId: "t-live", seq: 7, data: { id: "w2", callId: "w2", taskId: "d1", turnId: "t-live", seq: 7, tool: "web_search", phase: "start", intent: "DAX weekly", timestamp: 8 } },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="WORKING"
        activeTool="web_search"
        activeTurnId="t-live"
        turns={[{ turnId: "t-live", status: "active" }] as TurnEnvelope[]}
      />,
    );

    // Exactly one stable consolidated capsule; the split blocks never render.
    expect(screen.getAllByTestId("execution-live-plan")).toHaveLength(1);
    // Collapsed by default — phases appear after the capsule is expanded.
    fireEvent.click(screen.getByTestId("plan-capsule-toggle"));
    expect(screen.getByTestId("execution-plan-card")).toHaveTextContent("Research indices");
    expect(screen.getByTestId("execution-plan-card")).toHaveTextContent("Write summary");
    // No competing live surfaces: no bare live line, no generic indicator.
    expect(screen.queryByTestId("execution-live-line")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-responding-status-line")).not.toBeInTheDocument();
  });

  it("shows the card-level Verifying state while a verification step runs", () => {
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-v" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-v", seq: 1, data: { plan_id: "pv", goal: "Note", phases: [{ taskId: "v1", title: "Research", dependsOn: [] }, { taskId: "v2", title: "Write", dependsOn: ["v1"] }], timestamp: 2, turnId: "t-v", seq: 1 } },
      { type: "task_update", timestamp: 3, turnId: "t-v", seq: 2, data: { id: "e1", task_id: "v1", title: "Research", status: "completed", timestamp: 3, turnId: "t-v", seq: 2 } },
      { type: "task_update", timestamp: 4, turnId: "t-v", seq: 3, data: { id: "e2", task_id: "v2", title: "Write", status: "running", userStatus: "verifying", timestamp: 4, turnId: "t-v", seq: 3 } },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="WORKING"
        activeTool={null}
        activeTurnId="t-v"
        turns={[{ turnId: "t-v", status: "active" }] as TurnEnvelope[]}
      />,
    );

    expect(screen.getByTestId("execution-plan-verifying")).toHaveTextContent("Verifying");
  });
});

describe("detached-plan turn linkage (turn_bg_<planId>)", () => {
  it("renders the consolidated live card when the plan sits on the foreground turn and work streams on the background turn", () => {
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-fg" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-fg", seq: 1, data: { plan_id: "plan-9", goal: "Indices note", phases: [{ taskId: "s1", title: "Research Nikkei", dependsOn: [] }, { taskId: "s2", title: "Write note", dependsOn: ["s1"] }], timestamp: 2, turnId: "t-fg", seq: 1 } },
      { type: "message", timestamp: 3, data: { id: "a1", role: "assistant", content: "已将任务分解为 2 步计划并开始后台执行。", timestamp: 3, turnId: "t-fg", seq: 2 } as ChatMessage },
      { type: "task_update", timestamp: 4, turnId: "turn_bg_plan-9", seq: 1, data: { id: "ev-s1", task_id: "s1", title: "Research Nikkei", status: "running", timestamp: 4, turnId: "turn_bg_plan-9", seq: 1 } },
      { type: "tool_event", timestamp: 5, turnId: "turn_bg_plan-9", seq: 2, data: { id: "bgw1", callId: "bgw1", taskId: "s1", turnId: "turn_bg_plan-9", seq: 2, tool: "web_search", phase: "start", intent: "Nikkei weekly", timestamp: 5 } },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="WORKING"
        activeTool="web_search"
        activeTurnId="turn_bg_plan-9"
        turns={[{ turnId: "t-fg", status: "completed" }, { turnId: "turn_bg_plan-9", status: "active" }] as TurnEnvelope[]}
      />,
    );

    expect(screen.getAllByTestId("execution-live-plan")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("plan-capsule-toggle"));
    const card = screen.getByTestId("execution-plan-card");
    expect(card).toHaveTextContent("Research Nikkei");
    expect(card).toHaveTextContent("Write note");
    expect(screen.queryByTestId("execution-live-line")).not.toBeInTheDocument();
  });

  it("keeps the capsule alive from the background ENVELOPE after a session switch resets the foreground state", () => {
    // select_session's active_turn snapshot deliberately excludes background
    // turns (they must not lock the composer), so after switching back the
    // foreground is IDLE with no activeTurnId while the plan still runs. The
    // restored envelope is the truth — the capsule must survive on it
    // (operator bug report 2026-07-18: status vanished, then came back).
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-fg" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-fg", seq: 1, data: { plan_id: "plan-7", goal: "Brief", phases: [{ taskId: "b1", title: "Research topic", dependsOn: [] }], timestamp: 2, turnId: "t-fg", seq: 1 } },
      { type: "message", timestamp: 3, data: { id: "a1", role: "assistant", content: "Plan is running.", timestamp: 3, turnId: "t-fg", seq: 2 } as ChatMessage },
      { type: "task_update", timestamp: 4, turnId: "turn_bg_plan-7", seq: 1, data: { id: "ev1", task_id: "b1", title: "Research topic", status: "running", timestamp: 4, turnId: "turn_bg_plan-7", seq: 1 } },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        activeTurnId={null}
        turns={[
          { turnId: "t-fg", status: "completed", origin: "user" },
          { turnId: "turn_bg_plan-7", status: "active", origin: "background" },
        ] as TurnEnvelope[]}
      />,
    );

    expect(screen.getByTestId("execution-live-plan")).toBeInTheDocument();
  });
});

describe("one merged plan card per turn fold", () => {
  it("renders a single full-progress plan card even when narration split the turn into blocks", () => {
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-m" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-m", seq: 1, data: { plan_id: "pm", goal: "Note", phases: [{ taskId: "m1", title: "Research oil", dependsOn: [] }, { taskId: "m2", title: "Write note", dependsOn: ["m1"] }], timestamp: 2, turnId: "t-m", seq: 1 } },
      { type: "task_update", timestamp: 3, turnId: "t-m", seq: 2, data: { id: "e1", task_id: "m1", title: "Research oil", status: "completed", timestamp: 3, turnId: "t-m", seq: 2 } },
      { type: "tool_event", timestamp: 4, turnId: "t-m", seq: 3, data: { id: "mt1", callId: "mt1", taskId: "m1", turnId: "t-m", seq: 3, tool: "web_search", phase: "end", status: "success", intent: "oil", elapsed_ms: 200, timestamp: 4, sources: [{ title: "Oil", url: "https://example.com/oil" }] } },
      { type: "message", timestamp: 5, data: { id: "n1", role: "assistant", content: "第一步完成。", timestamp: 5, turnId: "t-m", seq: 4 } as ChatMessage },
      { type: "task_update", timestamp: 6, turnId: "t-m", seq: 5, data: { id: "e2", task_id: "m2", title: "Write note", status: "completed", timestamp: 6, turnId: "t-m", seq: 5 } },
      { type: "tool_event", timestamp: 7, turnId: "t-m", seq: 6, data: { id: "mt2", callId: "mt2", taskId: "m2", turnId: "t-m", seq: 6, tool: "file_write", phase: "end", status: "success", intent: "/w/note.md", elapsed_ms: 200, timestamp: 7 } },
      { type: "message", timestamp: 8, data: { id: "a9", role: "assistant", content: "完成，两句话已写入。", timestamp: 8, turnId: "t-m", seq: 7 } as ChatMessage },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        turns={[{ turnId: "t-m", status: "completed" }] as TurnEnvelope[]}
      />,
    );

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    const cards = screen.getAllByTestId("execution-plan-card");
    expect(cards).toHaveLength(1);
    // Headerless terminal card (operator decision 2026-07-19): no title or
    // fraction — the phase rows themselves carry the state, done rows struck
    // through.
    expect(cards[0]).not.toHaveTextContent("2 / 2");
    expect(cards[0]).toHaveTextContent("Research oil");
    expect(cards[0]).toHaveTextContent("Write note");
    const labels = within(cards[0]).getAllByTestId("execution-step-label");
    const research = labels.find((node) => node.textContent?.includes("Research oil"));
    expect(research?.className).toContain("line-through");
  });
});

describe("resolved approval dedup (operator report 2026-07-19)", () => {
  const approval = (id: string, ts: number, turnId: string | undefined, status: "pending" | "approved", description: string): TimelineItem => ({
    type: "approval_request",
    timestamp: ts,
    turnId,
    data: { id, action: "path_scope_grant", description, status, timestamp: ts, turnId } as never,
  });

  it("merges identical resolved approvals from one turn into a xN line — even for different paths", () => {
    // The reported case: two "已同意 · 访问项目之外的位置" lines back to back.
    // Descriptions differ per path server-side, but the resolved line shows
    // only the generic action label, so they are visually identical noise.
    renderChat([
      message("user", "go", 1),
      approval("a1", 2, "t-d", "approved", "Path scope: /tmp/a"),
      approval("a2", 3, "t-d", "approved", "Path scope: /tmp/b"),
      message("assistant", "done", 4),
    ]);
    expect(screen.getAllByTestId("approval-resolved-line")).toHaveLength(1);
    expect(screen.getByTestId("approval-repeat-count")).toHaveTextContent("×2");
  });

  it("never merges across turns, turn-less approvals, or pending requests", () => {
    renderChat([
      message("user", "go", 1),
      approval("b1", 2, "t-x", "approved", "Path scope: /tmp/a"),
      approval("b2", 3, "t-y", "approved", "Path scope: /tmp/a"),
      approval("b3", 4, undefined, "approved", "Path scope: /tmp/a"),
      approval("b4", 5, undefined, "approved", "Path scope: /tmp/a"),
      approval("b5", 6, "t-x", "pending", "Path scope: /tmp/c"),
      approval("b6", 7, "t-x", "pending", "Path scope: /tmp/c"),
    ]);
    // Different turns + two turn-less rows stay four separate resolved lines.
    expect(screen.getAllByTestId("approval-resolved-line")).toHaveLength(4);
    expect(screen.queryByTestId("approval-repeat-count")).not.toBeInTheDocument();
    // Pending approvals each remain a standing control card.
    expect(screen.getAllByTestId("approval-card")).toHaveLength(2);
  });
});

describe("artifact classes: workspace notes, inline visuals, view-all entry", () => {
  const baseTurn: TimelineItem[] = [
    { type: "message", timestamp: 1, turnId: "t-a", seq: 0, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-a" } as ChatMessage },
  ];
  const answer: TimelineItem = { type: "message", timestamp: 9, turnId: "t-a", seq: 9, data: { id: "a1", role: "assistant", content: "done", timestamp: 9, turnId: "t-a", seq: 9 } as ChatMessage };

  it("never renders workspace-role artifacts as chat rows", () => {
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "artifact", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "w1", plugin_id: "document_v1", title: "步骤底稿", status: "completed", data: { markdown: "# note", role: "workspace" }, timestamp: 2, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(<ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} />);
    expect(screen.queryByTestId("artifact-card")).not.toBeInTheDocument();
    expect(screen.queryByText("步骤底稿")).not.toBeInTheDocument();
  });

  it("keeps 查看全部产物 out of the chat rows — it lives inside the turn's fold", () => {
    // Operator decision 2026-07-19: a completed turn's chat rows are the answer
    // and its deliverable card(s); the product index is part of the process
    // disclosure, one level down.
    const opened: Artifact[] = [];
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "message", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "n1", role: "assistant", content: "开始整理。", timestamp: 2, turnId: "t-a", seq: 1 } as ChatMessage },
      { type: "artifact", timestamp: 3, turnId: "t-a", seq: 2, data: { id: "w1", plugin_id: "document_v1", title: "底稿A", status: "completed", data: { markdown: "x", role: "workspace" }, timestamp: 3, turnId: "t-a" } },
      { type: "artifact", timestamp: 4, turnId: "t-a", seq: 3, data: { id: "p1", plugin_id: "file_v1", title: "report.pdf", status: "completed", data: { role: "primary", path: "/o/report.pdf", filename: "report.pdf", ext: "pdf", size: 1000 }, timestamp: 4, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(
      <ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} onOpenArtifact={(a) => opened.push(a)} />,
    );
    // Not a chat row anymore.
    expect(screen.queryByTestId("chat-view-all-artifacts")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    const viewAll = within(screen.getByTestId("turn-fold-content")).getByTestId("chat-view-all-artifacts");
    expect(viewAll).toHaveTextContent("View all artifacts (2)");
    fireEvent.click(viewAll);
    expect(opened).toHaveLength(1);
    expect(opened[0].plugin_id).toBe("artifacts_v1");
    expect((opened[0].data.artifacts as Artifact[])).toHaveLength(2);
  });

  it("drops the fabricated detach-handoff sentence in plan turns; real text is never swallowed", () => {
    // "已将任务分解为 N 步计划并开始后台执行…" is runtime boilerplate whose
    // content the typed plan card already carries (operator report
    // 2026-07-19: 好傻逼). Suppression is shape-guarded AND scoped to turns
    // that actually admitted a plan.
    const handoff = "已将任务分解为 7 步计划并开始后台执行,完成后我会把结果发到这里。";
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, turnId: "t-a", seq: 0, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-a" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-a", seq: 1, data: { plan_id: "p1", goal: "分析", phases: [{ taskId: "s1", title: "下载数据", dependsOn: [] }], turnId: "t-a", timestamp: 2 } },
      { type: "message", timestamp: 3, turnId: "t-a", seq: 2, data: { id: "h1", role: "assistant", content: handoff, timestamp: 3, turnId: "t-a", seq: 2 } as ChatMessage },
      { type: "message", timestamp: 9, turnId: "turn_bg_p1", seq: 9, data: { id: "d1", role: "assistant", content: "分析完成，报告已生成。", timestamp: 9, turnId: "turn_bg_p1", seq: 9 } as ChatMessage },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        timelineCapabilities={["timeline_v1"]}
        turns={[{ turnId: "t-a", status: "completed" }, { turnId: "turn_bg_p1", status: "completed" }] as TurnEnvelope[]}
      />,
    );
    expect(screen.getByText("分析完成，报告已生成。")).toBeInTheDocument();
    // Not present collapsed — and, decisively, not inside the expanded fold
    // either (without the filter the sentence folds as narration and this
    // assertion fails: the pre-fix behavior this test exists to kill).
    expect(screen.queryByText(handoff)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    expect(screen.queryByText(handoff)).not.toBeInTheDocument();

    // Control: the same sentence in a turn WITHOUT plan_started stays (the
    // filter is scoped, not a global text ban).
    const control: TimelineItem[] = [
      { type: "message", timestamp: 1, turnId: "t-b", seq: 0, data: { id: "u2", role: "user", content: "hi", timestamp: 1, turnId: "t-b" } as ChatMessage },
      { type: "message", timestamp: 2, turnId: "t-b", seq: 1, data: { id: "m2", role: "assistant", content: handoff, timestamp: 2, turnId: "t-b", seq: 1 } as ChatMessage },
    ];
    renderWithLocale(
      <ChatView timeline={control} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-b", status: "completed" }] as TurnEnvelope[]} />,
    );
    expect(screen.getByText(handoff)).toBeInTheDocument();
  });

  it("fold claims the detached plan's bg-turn supporting files via plan_id linkage", () => {
    // plan_started lives on the foreground turn while execution (and its
    // files) stream under turn_bg_<planId> — without the linkage the bg
    // turn's supporting files leak out as a chat row beside the fold.
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, turnId: "t-a", seq: 0, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-a" } as ChatMessage },
      { type: "plan_started", timestamp: 2, turnId: "t-a", seq: 1, data: { plan_id: "p1", goal: "分析", phases: [{ taskId: "s1", title: "下载数据", dependsOn: [] }], turnId: "t-a", timestamp: 2 } },
      { type: "task_update", timestamp: 3, turnId: "turn_bg_p1", seq: 2, data: { id: "ev1", task_id: "s1", title: "下载数据", status: "completed", timestamp: 3 } },
      { type: "artifact", timestamp: 4, turnId: "turn_bg_p1", seq: 3, data: { id: "s1a", plugin_id: "file_v1", title: "chart.png", status: "completed", data: { role: "supporting", path: "/o/chart.png", filename: "chart.png", ext: "png", size: 10 }, timestamp: 4, turnId: "turn_bg_p1" } },
      { type: "message", timestamp: 9, turnId: "turn_bg_p1", seq: 9, data: { id: "d1", role: "assistant", content: "分析完成。", timestamp: 9, turnId: "turn_bg_p1", seq: 9 } as ChatMessage },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        timelineCapabilities={["timeline_v1"]}
        turns={[{ turnId: "t-a", status: "completed" }, { turnId: "turn_bg_p1", status: "completed" }] as TurnEnvelope[]}
      />,
    );
    // Collapsed: no supporting disclosure anywhere in the conversation.
    expect(screen.queryByRole("button", { name: /supporting file/i })).not.toBeInTheDocument();
    // Expanded: the fold houses it.
    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    expect(within(screen.getByTestId("turn-fold-content")).getByRole("button", { name: /1 supporting file/i })).toBeInTheDocument();
  });

  it("never renders supporting files twice when their rows precede the fold anchor (deterministic projection)", () => {
    // On the turn projection, a turn with no execution rows of its own keeps
    // its artifacts at low seq — BEFORE the interim narration that anchors the
    // fold. Order-dependent housing rendered the files twice: inline row
    // first, then again inside the fold (review finding 2026-07-19).
    const timeline: TimelineItem[] = [
      { type: "message", timestamp: 1, turnId: "t-a", seq: 0, data: { id: "u1", role: "user", content: "go", timestamp: 1, turnId: "t-a" } as ChatMessage },
      { type: "artifact", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "s1", plugin_id: "file_v1", title: "chart1.png", status: "completed", data: { role: "supporting", path: "/o/chart1.png", filename: "chart1.png", ext: "png", size: 10 }, timestamp: 2, turnId: "t-a" } },
      { type: "artifact", timestamp: 3, turnId: "t-a", seq: 2, data: { id: "s2", plugin_id: "file_v1", title: "chart2.png", status: "completed", data: { role: "supporting", path: "/o/chart2.png", filename: "chart2.png", ext: "png", size: 11 }, timestamp: 3, turnId: "t-a" } },
      { type: "message", timestamp: 4, turnId: "t-a", seq: 3, data: { id: "n1", role: "assistant", content: "整理数据中。", timestamp: 4, turnId: "t-a", seq: 3 } as ChatMessage },
      { type: "message", timestamp: 9, turnId: "t-a", seq: 9, data: { id: "a1", role: "assistant", content: "done", timestamp: 9, turnId: "t-a", seq: 9 } as ChatMessage },
    ];
    renderWithLocale(
      <ChatView
        timeline={timeline}
        sessionState="IDLE"
        activeTool={null}
        timelineCapabilities={["timeline_v1"]}
        turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]}
      />,
    );
    // No inline disclosure row in the conversation.
    expect(screen.queryByRole("button", { name: /supporting file/i })).not.toBeInTheDocument();
    // Exactly one disclosure, inside the fold.
    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    expect(screen.getAllByRole("button", { name: /2 supporting files/i })).toHaveLength(1);
    expect(within(screen.getByTestId("turn-fold-content")).getByRole("button", { name: /2 supporting files/i })).toBeInTheDocument();
  });

  it("keeps 查看全部产物 under the primary card when the turn has no fold at all", () => {
    // A turn with no foldable process rows (e.g. plan delivery whose execution
    // streamed under another turn id) has no 查看处理过程 — without the
    // fallback its working notes would be stranded with no entry anywhere
    // (review finding 2026-07-19).
    const opened: Artifact[] = [];
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "artifact", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "w1", plugin_id: "document_v1", title: "底稿A", status: "completed", data: { markdown: "x", role: "workspace" }, timestamp: 2, turnId: "t-a" } },
      { type: "artifact", timestamp: 3, turnId: "t-a", seq: 2, data: { id: "p1", plugin_id: "file_v1", title: "report.pdf", status: "completed", data: { role: "primary", path: "/o/report.pdf", filename: "report.pdf", ext: "pdf", size: 1000 }, timestamp: 3, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(
      <ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} onOpenArtifact={(a) => opened.push(a)} />,
    );
    expect(screen.queryByTestId("turn-fold-summary")).not.toBeInTheDocument();
    const viewAll = screen.getByTestId("chat-view-all-artifacts");
    expect(viewAll).toHaveTextContent("View all artifacts (2)");
    fireEvent.click(viewAll);
    expect(opened).toHaveLength(1);
    expect((opened[0].data.artifacts as Artifact[])).toHaveLength(2);
  });

  it("houses a folded turn's supporting files inside 查看处理过程, not as a chat row", () => {
    // The UCI Online Retail incident shape: report + working material. The
    // supporting disclosure must not sit in the conversation; it belongs to
    // the turn's process fold.
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "message", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "n1", role: "assistant", content: "下载数据集中。", timestamp: 2, turnId: "t-a", seq: 1 } as ChatMessage },
      { type: "artifact", timestamp: 3, turnId: "t-a", seq: 2, data: { id: "p1", plugin_id: "file_v1", title: "report.pdf", status: "completed", data: { role: "primary", path: "/o/report.pdf", filename: "report.pdf", ext: "pdf", size: 1000 }, timestamp: 3, turnId: "t-a" } },
      { type: "artifact", timestamp: 4, turnId: "t-a", seq: 3, data: { id: "s1", plugin_id: "file_v1", title: "chart1.png", status: "completed", data: { role: "supporting", path: "/o/chart1.png", filename: "chart1.png", ext: "png", size: 10 }, timestamp: 4, turnId: "t-a" } },
      { type: "artifact", timestamp: 5, turnId: "t-a", seq: 4, data: { id: "s2", plugin_id: "file_v1", title: "chart2.png", status: "completed", data: { role: "supporting", path: "/o/chart2.png", filename: "chart2.png", ext: "png", size: 11 }, timestamp: 5, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(
      <ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} />,
    );
    // The conversation: deliverable card only, no supporting disclosure row.
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /supporting file/i })).not.toBeInTheDocument();

    // Inside the fold: there they are.
    fireEvent.click(screen.getByTestId("turn-fold-summary"));
    const foldContent = screen.getByTestId("turn-fold-content");
    fireEvent.click(within(foldContent).getByRole("button", { name: /2 supporting files/i }));
    expect(within(foldContent).getByText("chart1.png")).toBeInTheDocument();
    expect(within(foldContent).getByText("chart2.png")).toBeInTheDocument();
  });

  it("renders a completed svg visualization inline with a bounded frame", () => {
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "artifact", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "v1", plugin_id: "sandpack_v1", title: "收益率曲线", status: "completed", data: { content_type: "svg", code: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>" }, timestamp: 2, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(<ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} />);
    expect(screen.getByTestId("inline-visual-card")).toHaveTextContent("收益率曲线");
    expect(screen.getByTestId("inline-visual-frame")).toHaveAttribute("sandbox", "allow-scripts");
    expect(screen.queryByTestId("artifact-card")).not.toBeInTheDocument();
  });

  it("enforces the no-network CSP inside every inline visual document", () => {
    // The `sandbox` attribute does NOT block network — the CSP meta is what
    // makes the create_artifact self-containment contract enforced truth.
    const fragment = "<div id='chart'></div><script src='https://cdn.example.com/lib.js'></script>";
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "artifact", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "v-svg", plugin_id: "sandpack_v1", title: "图", status: "completed", data: { content_type: "svg", code: "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>" }, timestamp: 2, turnId: "t-a" } },
      { type: "artifact", timestamp: 3, turnId: "t-a", seq: 2, data: { id: "v-html", plugin_id: "sandpack_v1", title: "件", status: "completed", data: { content_type: "html", code: fragment }, timestamp: 3, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(<ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} />);
    const frames = screen.getAllByTestId("inline-visual-frame");
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      const srcDoc = frame.getAttribute("srcdoc") ?? "";
      expect(srcDoc).toContain('http-equiv="Content-Security-Policy"');
      expect(srcDoc).toContain("default-src 'none'");
      // The policy must precede any author script to take effect.
      expect(srcDoc.indexOf("Content-Security-Policy")).toBeLessThan(
        srcDoc.includes("cdn.example.com") ? srcDoc.indexOf("cdn.example.com") : srcDoc.length,
      );
    }
  });

  it("renders a standalone HTML page as a click-to-open card, never the inline frame", () => {
    // A full page (<!doctype>/<html> shell) is a document deliverable — pages
    // are read, not glanced (the 宏观到债券 report regression, 2026-07-18).
    const page = "<!DOCTYPE html>\n<html lang='zh-CN'><head><title>报告</title></head><body><h1>宏观到债券市场定量评估</h1></body></html>";
    const timeline: TimelineItem[] = [
      ...baseTurn,
      { type: "artifact", timestamp: 2, turnId: "t-a", seq: 1, data: { id: "rep1", plugin_id: "sandpack_v1", title: "Macro-to-Bond Report", status: "completed", data: { content_type: "html", code: page }, timestamp: 2, turnId: "t-a" } },
      answer,
    ];
    renderWithLocale(<ChatView timeline={timeline} sessionState="IDLE" activeTool={null} turns={[{ turnId: "t-a", status: "completed" }] as TurnEnvelope[]} />);
    expect(screen.queryByTestId("inline-visual-card")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-card")).toHaveTextContent("Macro-to-Bond Report");
  });
});

describe("upward infinite history scroll (operator decision 2026-07-18)", () => {
  const scrollTurn: TimelineItem[] = [
    { type: "message", timestamp: 1, turnId: "t-scroll", seq: 1, data: { id: "u-scroll", role: "user", content: "hi", timestamp: 1, turnId: "t-scroll" } },
    { type: "message", timestamp: 2, turnId: "t-scroll", seq: 2, data: { id: "a-scroll", role: "assistant", content: "hello", timestamp: 2, turnId: "t-scroll" } },
  ];
  const fullProps = {
    sessionState: "IDLE" as SessionState,
    activeTool: null,
    onApprove: vi.fn(),
    onReject: vi.fn(),
    onSend: vi.fn(),
    onRegenerate: vi.fn(),
  };

  it("loads older history when scrolling near the top — once per fetch", () => {
    const onLoadOlderHistory = vi.fn();
    renderWithLocale(
      <ChatView
        {...fullProps}
        timeline={scrollTurn}
        hasOlderHistory
        loadingOlderHistory={false}
        onLoadOlderHistory={onLoadOlderHistory}
      />,
    );
    const region = screen.getByTestId("chat-scroll-region");
    region.scrollTop = 600;
    fireEvent.scroll(region);
    expect(onLoadOlderHistory).not.toHaveBeenCalled();
    region.scrollTop = 100;
    fireEvent.scroll(region);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
    // Re-scrolling before the fetch settles must not double-fire.
    fireEvent.scroll(region);
    expect(onLoadOlderHistory).toHaveBeenCalledTimes(1);
  });

  it("shows a quiet inline loading line while fetching and never a pagination button", () => {
    renderWithLocale(
      <ChatView
        {...fullProps}
        timeline={scrollTurn}
        hasOlderHistory
        loadingOlderHistory
        onLoadOlderHistory={vi.fn()}
      />,
    );
    expect(screen.getByTestId("chat-loading-older")).toHaveTextContent("Loading earlier activity…");
    // The old manual control is gone for good — history is a scroll, not a button.
    expect(screen.queryByText("Load earlier activity")).not.toBeInTheDocument();
  });

  it("does not trigger at the top when no older history exists", () => {
    const onLoadOlderHistory = vi.fn();
    renderWithLocale(
      <ChatView
        {...fullProps}
        timeline={scrollTurn}
        hasOlderHistory={false}
        loadingOlderHistory={false}
        onLoadOlderHistory={onLoadOlderHistory}
      />,
    );
    const region = screen.getByTestId("chat-scroll-region");
    region.scrollTop = 0;
    fireEvent.scroll(region);
    expect(onLoadOlderHistory).not.toHaveBeenCalled();
  });
});
