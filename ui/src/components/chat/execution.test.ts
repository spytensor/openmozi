import { describe, expect, it } from "vitest";
import type { Artifact, ChatMessage, TaskUpdate, TimelineItem, ToolEvent } from "@/types";
import {
  buildChatRenderItems,
  buildToolStepSummary,
  inferMessageLocale,
  sanitizeTaskTitle,
  toolDisplayLabel,
  toolActionLabel,
  toolRunningActionLabel,
  shouldRenderExecutionBlock,
} from "./execution";

function message(role: ChatMessage["role"], content: string, timestamp: number): TimelineItem {
  return {
    type: "message",
    timestamp,
    data: {
      id: `msg-${timestamp}`,
      role,
      content,
      timestamp,
    } satisfies ChatMessage,
  };
}

function task(task_id: string, title: string, status: TaskUpdate["status"], timestamp: number, turnId?: string): TimelineItem {
  return {
    type: "task_update",
    timestamp,
    data: {
      id: `task-${task_id}-${timestamp}`,
      task_id,
      turnId,
      title,
      status,
      timestamp,
    } satisfies TaskUpdate,
  };
}

function tool(
  callId: string,
  toolName: string,
  timestamp: number,
  turnId?: string,
  status: ToolEvent["status"] = "success",
  overrides: Partial<ToolEvent> = {},
): TimelineItem {
  return {
    type: "tool_event",
    timestamp,
    data: {
      id: `tool-${callId}`,
      callId,
      taskId: `task-${callId}`,
      turnId,
      tool: toolName,
      phase: "end",
      status,
      elapsed_ms: 1200,
      timestamp,
      ...overrides,
    } satisfies ToolEvent,
  };
}

function artifact(id: string, timestamp: number, pluginId?: string, turnId?: string): TimelineItem {
  return {
    type: "artifact",
    timestamp,
    data: {
      id,
      plugin_id: pluginId,
      title: "Artifact",
      status: "completed",
      data: turnId ? { meta: { turn_id: turnId } } : {},
      timestamp,
    } satisfies Artifact,
  };
}

describe("execution helpers", () => {
  it("groups task and tool updates into one execution block for the same turn", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Find me a hotel", 1),
      task("search", "[Iteration 2] Analyze best options", "running", 2, "turn-1"),
      tool("search-1", "web_search", 3, "turn-1"),
      task("rank", "Compare shortlisted hotels", "pending", 4, "turn-1"),
      message("assistant", "Here are the best options.", 5),
    ]);

    expect(renderItems).toHaveLength(3);
    expect(renderItems[1]?.kind).toBe("execution");
    if (renderItems[1]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[1].block.turnId).toBe("turn-1");
    expect(renderItems[1].block.taskCount).toBe(2);
    expect(renderItems[1].block.toolCount).toBe(1);
    expect(renderItems[1].block.status).toBe("running");
    expect(renderItems[1].block.headline).toBe("Analyze best options");
  });

  it("keeps a pre-answer failed execution block in chronological place for the turn fold", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Analyze the image", 1),
      tool("vision-1", "image_analysis", 2, "turn-1", "error", { error: "Model route unavailable" }),
      message("assistant", "Image analysis is unavailable right now.", 3),
    ]);

    // Survived failures are process the turn moved past: they stay before the
    // answer (true chronology) so the presentation layer folds them.
    expect(renderItems.map((item) => item.kind === "execution" ? `execution:${item.block.status}` : (item.item.data as ChatMessage).role)).toEqual([
      "user",
      "execution:error",
      "assistant",
    ]);
  });

  it("places an artifact after the final assistant response", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Build the report", 1),
      artifact("report-1", 2, undefined, "turn-1"),
      message("assistant", "The report is ready.", 3),
    ]);

    expect(renderItems.map((item) => item.kind === "execution" ? `execution:${item.block.status}` : item.item.type === "message" ? (item.item.data as ChatMessage).role : item.item.type)).toEqual([
      "user",
      "assistant",
      "artifact",
    ]);
  });

  it("keeps running execution in live event order", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Analyze the image", 1),
      task("vision", "Analyze image", "running", 2, "turn-1"),
      message("assistant", "I am checking the image.", 3),
    ]);

    expect(renderItems.map((item) => item.kind === "execution" ? `execution:${item.block.status}` : (item.item.data as ChatMessage).role)).toEqual([
      "user",
      "execution:running",
      "assistant",
    ]);
  });

  it("splits consecutive execution items when the turn changes", () => {
    const renderItems = buildChatRenderItems([
      task("search-a", "Search A", "completed", 10, "turn-a"),
      tool("tool-a", "web_search", 11, "turn-a"),
      task("search-b", "Search B", "running", 12, "turn-b"),
      tool("tool-b", "shell_exec", 13, "turn-b"),
    ]);

    const executionBlocks = renderItems.filter((item) => item.kind === "execution");
    expect(executionBlocks).toHaveLength(2);
    if (executionBlocks[0]?.kind !== "execution" || executionBlocks[1]?.kind !== "execution") {
      throw new Error("expected execution blocks");
    }
    expect(executionBlocks[0].block.turnId).toBe("turn-a");
    expect(executionBlocks[1].block.turnId).toBe("turn-b");
    expect(executionBlocks[1].block.status).toBe("running");
  });

  it("keeps chat labels user-facing", () => {
    expect(sanitizeTaskTitle("[Iteration 2] 搜索广东省内符合要求的酒店")).toBe("搜索广东省内符合要求的酒店");
    expect(sanitizeTaskTitle(undefined)).toBe("");
    expect(toolDisplayLabel("shell_exec")).toBe("Command");
    expect(toolDisplayLabel("web_fetch")).toBe("Source");
    expect(toolDisplayLabel("use_skill")).toBe("Skill");
    expect(toolActionLabel("web_search")).toBe("search public information");
    expect(toolActionLabel("web_search", "zh-CN")).toBe("搜索公开资料");
    expect(toolActionLabel(undefined, "zh-CN")).toBe("处理任务步骤");
    // The skill name is runtime truth the user asked to see (operator, 2026-07-18).
    expect(toolRunningActionLabel("use_skill", "en", "imagegen")).toBe("Loading skill imagegen");
    expect(toolRunningActionLabel("use_skill", "zh-CN", "imagegen")).toBe("正在加载技能 imagegen");
  });

  it("maps skill activation rows and skill attribution metadata from real tool events", () => {
    const activation = buildToolStepSummary(
      {
        id: "tool-skill",
        callId: "skill",
        turnId: "turn-1",
        tool: "use_skill",
        phase: "end",
        status: "success",
        skillName: "imagegen",
        skillDescription: "Generate images from prompts",
        skillLoadOutcome: "success",
        intent: "Load skill imagegen",
        timestamp: 1,
      } satisfies ToolEvent,
      "en",
    );

    expect(activation.kind).toBe("skill");
    expect(activation.label).toBe("Skill(imagegen)");
    expect(activation.timelineLabel).toBe("Skill(imagegen)");
    expect(activation.skillDescription).toBe("Generate images from prompts");
    expect(activation.skillLoadOutcome).toBe("success");
    expect(activation.showHostnameChip).toBe(false);
    expect(activation.isSkillActivation).toBe(true);
    expect(activation.skillSuffixName).toBeNull();

    const attributed = buildToolStepSummary(
      {
        id: "tool-search",
        callId: "search",
        turnId: "turn-1",
        tool: "web_search",
        phase: "end",
        status: "success",
        skillName: "research",
        intent: "OpenAI docs",
        timestamp: 2,
      } satisfies ToolEvent,
      "en",
    );

    expect(attributed.label).toBe("Search OpenAI docs");
    expect(attributed.isSkillActivation).toBe(false);
    expect(attributed.skillSuffixName).toBe("research");

    const ownTool = buildToolStepSummary(
      {
        id: "tool-own",
        callId: "own",
        turnId: "turn-1",
        tool: "research",
        phase: "end",
        status: "success",
        skillName: "research",
        timestamp: 3,
      } satisfies ToolEvent,
      "en",
    );

    expect(ownTool.skillSuffixName).toBeNull();
  });

  it("separates URL summary labels from hostname chips", () => {
    const domainOnly = buildToolStepSummary(
      {
        id: "tool-domain",
        callId: "domain",
        turnId: "turn-1",
        tool: "web_fetch",
        phase: "end",
        status: "success",
        intent: "https://anthropic.com",
        timestamp: 1,
      } satisfies ToolEvent,
      "en",
    );

    expect(domainOnly.label).toBe("Read anthropic.com");
    expect(domainOnly.timelineLabel).toBe("Read");
    expect(domainOnly.showHostnameChip).toBe(true);

    const titledSource = buildToolStepSummary(
      {
        id: "tool-title",
        callId: "title",
        turnId: "turn-1",
        tool: "web_fetch",
        phase: "end",
        status: "success",
        intent: "https://anthropic.com/news",
        result: "<title>Claude product news</title>",
        timestamp: 2,
      } satisfies ToolEvent,
      "en",
    );

    expect(titledSource.timelineLabel).toBe("Read Claude product news");
    expect(titledSource.showHostnameChip).toBe(true);

    const domainInTitle = buildToolStepSummary(
      {
        id: "tool-domain-title",
        callId: "domain-title",
        turnId: "turn-1",
        tool: "web_fetch",
        phase: "end",
        status: "success",
        intent: "https://anthropic.com/news",
        result: "<title>Updates from anthropic.com</title>",
        timestamp: 3,
      } satisfies ToolEvent,
      "en",
    );

    expect(domainInTitle.timelineLabel).toBe("Read Updates from anthropic.com");
    expect(domainInTitle.showHostnameChip).toBe(false);
  });

  it("infers only supported transcript locales from user text", () => {
    expect(inferMessageLocale("昨天美股发生了什么")).toBe("zh-CN");
    expect(inferMessageLocale("What happened in the market yesterday?")).toBe("en");
    expect(inferMessageLocale("昨日の市場はどうでしたか")).toBeUndefined();
    expect(inferMessageLocale("어제 시장은 어땠나요")).toBeUndefined();
  });

  it("does not crash when restored legacy tool events are missing a tool name", () => {
    const renderItems = buildChatRenderItems([
      {
        type: "tool_event",
        timestamp: 1,
        data: {
          id: "tool-legacy",
          callId: "legacy",
          phase: "end",
          status: "success",
          intent: "Verify persisted browser timeline",
          timestamp: 1,
        } as ToolEvent,
      },
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.headline).toBe("Verify persisted browser timeline");
  });

  it("keeps runtime ids out of the execution headline", () => {
    const renderItems = buildChatRenderItems([
      tool("browser-1", "browser_extract", 1, "turn-1", "success", {
        intent: "browser_1782900081195_0g92fm",
      }),
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.headline).toBe("read page information");
  });

  it("aggregates repeated tool failures into one user-facing issue summary", () => {
    const rawError =
      "Error: web search failed — SEARCH1API_KEY environment variable is not set IMPORTANT: Do NOT answer this question from training data.";
    const renderItems = buildChatRenderItems([
      tool("search-1", "web_search", 1, "turn-1", "error", { error: rawError }),
      tool("search-2", "web_search", 2, "turn-1", "error", { error: rawError }),
      tool("search-3", "web_search", 3, "turn-1", "error", { error: rawError }),
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.issueCount).toBe(3);
    expect(renderItems[0].block.issueSummaries).toHaveLength(1);
    expect(renderItems[0].block.issueSummaries[0]).toMatchObject({
      label: "search public information",
      count: 3,
      detail: "Missing SEARCH1API_KEY",
    });
  });

  it("treats empty-result searches as benign — no alarm, no issue count", () => {
    const noResults =
      'Search API error 404: {"ok":false,"message":"No results found for query: A股 基金 2026","error":"No results found for query: A股 基金 2026"}';
    const renderItems = buildChatRenderItems([
      tool("search-404", "web_search", 1, "turn-1", "error", { error: noResults }),
      tool("search-ok", "web_search", 2, "turn-1", "success", { result: "found useful data" }),
      tool("fetch-ok", "web_fetch", 3, "turn-1", "success", { result: "page body" }),
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    const block = renderItems[0].block;
    // An empty search is normal research friction, not something to warn about.
    expect(block.issueCount).toBe(0);
    expect(block.issueSummaries).toHaveLength(0);
    expect(block.status).toBe("success");
  });

  it("still surfaces hard tool failures (missing key) as real issues", () => {
    const missingKey =
      "Error: web search failed — SEARCH1API_KEY environment variable is not set";
    const renderItems = buildChatRenderItems([
      tool("search-1", "web_search", 1, "turn-1", "error", { error: missingKey }),
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.issueCount).toBe(1);
    expect(renderItems[0].block.issueSummaries[0]).toMatchObject({ detail: "Missing SEARCH1API_KEY" });
  });

  const planStartedItem = (turnId: string, timestamp: number): TimelineItem => ({
    type: "plan_started",
    timestamp,
    turnId,
    data: {
      plan_id: "p1",
      goal: "Macro analysis",
      phases: [{ taskId: "step-1", title: "Collect data", dependsOn: [] }],
      timestamp,
      turnId,
    },
  });

  it("does not count recovered tool errors as issues on a plan-backed turn (G1)", () => {
    // Real case 2026-07-18: 5/5 steps green + 1 failed verification row read
    // "Needs attention (15)" because 14 web_fetch 502s the runner retried past
    // were tallied in. With a plan present, only failed TASKS are issues.
    const hardError = "Error: Crawl API error 502: Failed to crawl URL";
    const renderItems = buildChatRenderItems([
      planStartedItem("turn-1", 0),
      task("step-1", "Collect data", "completed", 1, "turn-1"),
      task("step-2", "Build report", "completed", 2, "turn-1"),
      tool("fetch-1", "web_fetch", 3, "turn-1", "error", { error: hardError }),
      tool("fetch-2", "web_fetch", 4, "turn-1", "error", { error: hardError }),
    ]);
    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.issueCount).toBe(0);
  });

  it("counts failed tasks (verification row included) on a plan-backed turn (G1)", () => {
    const hardError = "Error: Crawl API error 502: Failed to crawl URL";
    const renderItems = buildChatRenderItems([
      planStartedItem("turn-1", 0),
      task("step-1", "Collect data", "completed", 1, "turn-1"),
      task("root:verification", "Result verification", "failed", 2, "turn-1"),
      tool("fetch-1", "web_fetch", 3, "turn-1", "error", { error: hardError }),
    ]);
    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.issueCount).toBe(1);
  });

  it("treats a turn_bg_* block as plan-backed even without a plan_started row in its items (G1, live-verified)", () => {
    // The typed plan lives on the FOREGROUND turn; the projection forwards it
    // onto the bg block only AFTER the model is built. A restored bg block must
    // still use the plan tally — the live regression read "(9)" = 1 failed
    // task + 8 windowed tool errors.
    const hardError = "Error: Crawl API error 502: Failed to crawl URL";
    const renderItems = buildChatRenderItems([
      task("step-1", "Collect data", "completed", 1, "turn_bg_root-1"),
      task("root:verification", "Result verification", "failed", 2, "turn_bg_root-1"),
      tool("fetch-1", "web_fetch", 3, "turn_bg_root-1", "error", { error: hardError }),
      tool("fetch-2", "web_fetch", 4, "turn_bg_root-1", "error", { error: hardError }),
    ]);
    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.issueCount).toBe(1);
  });

  it("keeps counting tool errors on a plan-LESS turn that carries a handoff task row (G1 HIGH-2)", () => {
    // A completed delegated/handoff task row must not suppress a genuine tool
    // failure: the gate is the plan, not the mere presence of task rows.
    const missingKey = "Error: web search failed — SEARCH1API_KEY environment variable is not set";
    const renderItems = buildChatRenderItems([
      task("delegated-1", "Handoff to worker", "completed", 1, "turn-1"),
      tool("search-1", "web_search", 2, "turn-1", "error", { error: missingKey }),
    ]);
    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.issueCount).toBe(1);
  });

  it("hides orphan completed lifecycle progress before the user request", () => {
    const renderItems = buildChatRenderItems([
      {
        type: "task_update",
        timestamp: 1,
        data: {
          id: "task-received",
          task_id: "turn-orphan:received",
          turnId: "turn-orphan",
          title: "Request received",
          status: "completed",
          userStatus: "received",
          timestamp: 1,
        } satisfies TaskUpdate,
      },
      message("user", "Make a report", 2),
    ]);

    expect(renderItems).toHaveLength(1);
    expect(renderItems[0]?.kind).toBe("single");
    if (renderItems[0]?.kind !== "single") throw new Error("expected user message");
    expect(renderItems[0].item).toMatchObject({
      type: "message",
      data: expect.objectContaining({ role: "user" }),
    });
  });

  it("suppresses retried source failures after the same source succeeds", () => {
    const url = "https://example.com/news/market";
    const rawError = "Error: Crawl API error 502: Failed to crawl URL: Crawl service failed with status 500";
    const renderItems = buildChatRenderItems([
      tool("fetch-1", "web_fetch", 1, "turn-1", "error", { intent: url, error: rawError }),
      tool("fetch-2", "web_fetch", 2, "turn-1", "success", { intent: url, result: url }),
      tool("fetch-3", "web_fetch", 3, "turn-1", "success", {
        intent: "https://example.com/news/other",
        result: "https://example.com/news/other",
      }),
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.status).toBe("success");
    expect(renderItems[0].block.issueCount).toBe(0);
    expect(renderItems[0].block.issueSummaries).toHaveLength(0);
    expect(renderItems[0].block.toolCount).toBe(2);
    expect(renderItems[0].block.tools.map((event) => event.callId)).toEqual(["fetch-2", "fetch-3"]);
  });

  it("keeps only unresolved source failures and scrubs crawl internals", () => {
    const rawError = "Error: Crawl API error 502: Failed to crawl URL: Crawl service failed with status 500";
    const renderItems = buildChatRenderItems([
      tool("fetch-1", "web_fetch", 1, "turn-1", "error", {
        intent: "https://example.com/retried",
        error: rawError,
      }),
      tool("fetch-2", "web_fetch", 2, "turn-1", "success", {
        intent: "https://example.com/retried",
        result: "https://example.com/retried",
      }),
      tool("fetch-3", "web_fetch", 3, "turn-1", "error", {
        intent: "https://example.com/unavailable",
        error: rawError,
      }),
    ]);

    expect(renderItems[0]?.kind).toBe("execution");
    if (renderItems[0]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[0].block.status).toBe("mixed");
    expect(renderItems[0].block.issueCount).toBe(1);
    expect(renderItems[0].block.toolCount).toBe(2);
    expect(renderItems[0].block.issueSummaries).toHaveLength(1);
    expect(renderItems[0].block.issueSummaries[0]).toMatchObject({
      label: "search public information",
      count: 1,
      detail: "Source temporarily unavailable",
    });
  });

  it("hides duplicate execution blocks when workspace hub artifact exists for the same turn", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Do the work", 1),
      task("search", "Analyze options", "completed", 2, "turn-1"),
      tool("search-1", "web_search", 3, "turn-1"),
      artifact("artifact-1", 4, "workspace_hub_v1", "turn-1"),
      message("assistant", "Done.", 5),
    ]);

    expect(renderItems).toHaveLength(3);
    expect(renderItems.some((item) => item.kind === "execution")).toBe(false);
  });

  it("hides duplicate execution blocks when a live work surface exists for the same turn", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Write a report", 1),
      task("turn-1:working", "Writing artifact", "running", 2, "turn-1"),
      tool("artifact-1", "create_artifact", 3, "turn-1"),
      artifact("live-1", 4, "live_work_v1", "turn-1"),
    ]);

    expect(renderItems).toHaveLength(2);
    expect(renderItems.map((item) => item.kind)).toEqual(["single", "single"]);
  });

  it("suppresses simple successful work logs so small tasks do not feel over-managed", () => {
    const renderItems = buildChatRenderItems([
      message("user", "What's the weather?", 1),
      {
        type: "task_update",
        timestamp: 2,
        data: {
          id: "task-received",
          task_id: "turn-weather:received",
          turnId: "turn-weather",
          title: "Request received",
          status: "completed",
          userStatus: "received",
          timestamp: 2,
        } satisfies TaskUpdate,
      },
      tool("weather", "web_fetch", 3, "turn-weather", "success", {
        elapsed_ms: 900,
        intent: "https://example.com/weather",
        result: "https://example.com/weather",
      }),
      {
        type: "task_update",
        timestamp: 4,
        data: {
          id: "task-responding",
          task_id: "turn-weather:responding",
          turnId: "turn-weather",
          title: "Response prepared",
          status: "completed",
          userStatus: "responding",
          timestamp: 4,
        } satisfies TaskUpdate,
      },
      message("assistant", "It is sunny.", 5),
    ]);

    expect(renderItems).toHaveLength(2);
    expect(renderItems.map((item) => item.kind)).toEqual(["single", "single"]);
  });

  it("keeps one stable successful work log before the final answer for complex work", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Research A-share funds and build a plan", 1),
      {
        type: "task_update",
        timestamp: 2,
        data: {
          id: "task-received",
          task_id: "turn-research:received",
          turnId: "turn-research",
          title: "Request received",
          status: "completed",
          userStatus: "received",
          timestamp: 2,
        } satisfies TaskUpdate,
      },
      {
        type: "task_update",
        timestamp: 3,
        data: {
          id: "task-planning",
          task_id: "turn-research:planning",
          turnId: "turn-research",
          title: "Planned approach",
          status: "completed",
          userStatus: "planning",
          timestamp: 3,
        } satisfies TaskUpdate,
      },
      tool("source-1", "web_fetch", 4, "turn-research", "success", { intent: "https://example.com/a" }),
      tool("source-2", "web_fetch", 5, "turn-research", "success", { intent: "https://example.com/b" }),
      task("analysis", "Compare sources and build the plan", "completed", 5.5, "turn-research"),
      message("assistant", "Here is the plan.", 6),
    ]);

    expect(renderItems).toHaveLength(3);
    expect(renderItems[0]?.kind).toBe("single");
    expect(renderItems[1]?.kind).toBe("execution");
    expect(renderItems[2]?.kind).toBe("single");
    if (renderItems[1]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[1].block.turnId).toBe("turn-research");
    expect(renderItems[1].block.toolCount).toBe(2);
  });

  it("suppresses a simple successful block with six incidental tools under one minute after the answer", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Check this", 1),
      ...Array.from({ length: 6 }, (_, index) => tool(`incidental-${index}`, "web_fetch", index + 2, "turn-simple", "success", {
        intent: `https://example.com/${index}`,
        elapsed_ms: 5_000,
      })),
      message("assistant", "Checked.", 9),
    ]);

    expect(renderItems.map((item) => item.kind)).toEqual(["single", "single"]);
    const blockItem = buildChatRenderItems(Array.from({ length: 6 }, (_, index) => tool(`standalone-${index}`, "web_fetch", index + 1, "turn-simple", "success", {
      elapsed_ms: 5_000,
    })))[0];
    if (blockItem?.kind !== "execution") throw new Error("expected execution block");
    expect(shouldRenderExecutionBlock(blockItem.block, message("assistant", "Checked.", 9))).toBe(false);
  });

  it("suppresses an early generic lifecycle block when concrete same-turn work appears later", () => {
    const renderItems = buildChatRenderItems([
      message("user", "昨天美股发生了什么", 1),
      {
        type: "task_update",
        timestamp: 2,
        data: {
          id: "task-market-received",
          task_id: "turn-market:received",
          turnId: "turn-market",
          title: "Request received",
          status: "completed",
          userStatus: "received",
          timestamp: 2,
        } satisfies TaskUpdate,
      },
      {
        type: "task_update",
        timestamp: 3,
        data: {
          id: "task-market-planning",
          task_id: "turn-market:planning",
          turnId: "turn-market",
          title: "Understood request and planned",
          status: "completed",
          userStatus: "planning",
          timestamp: 3,
        } satisfies TaskUpdate,
      },
      {
        type: "task_update",
        timestamp: 4,
        data: {
          id: "task-market-working",
          task_id: "turn-market:working",
          turnId: "turn-market",
          title: "Working on task",
          status: "running",
          userStatus: "working",
          timestamp: 4,
        } satisfies TaskUpdate,
      },
      message("assistant", "Let me search for the latest US stock market information.", 5),
      task("market-recap", "美股 2026年7月2日 行情回顾", "running", 6, "turn-market"),
      tool("market-search", "web_search", 7, "turn-market", "success", {
        intent: "US stock market July 2 2026 recap summary",
      }),
    ]);

    expect(renderItems.map((item) => item.kind)).toEqual(["single", "single", "execution"]);
    expect(renderItems[2]?.kind).toBe("execution");
    if (renderItems[2]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[2].block.locale).toBe("zh-CN");
    expect(renderItems[2].block.headline).toBe("美股 2026年7月2日 行情回顾");
    expect(renderItems[2].block.tasks.every((task) => task.userStatus === "received" || task.userStatus === "planning" || task.userStatus === "working")).toBe(false);
  });

  it("suppresses early lifecycle progress for the same user turn even when restored turn ids drift", () => {
    const renderItems = buildChatRenderItems([
      message("user", "昨天美股发生了什么", 1),
      {
        type: "task_update",
        timestamp: 2,
        data: {
          id: "task-old-received",
          task_id: "turn-old:received",
          turnId: "turn-old",
          title: "Request received",
          status: "completed",
          userStatus: "received",
          timestamp: 2,
        } satisfies TaskUpdate,
      },
      {
        type: "task_update",
        timestamp: 3,
        data: {
          id: "task-old-working",
          task_id: "turn-old:working",
          turnId: "turn-old",
          title: "Working on task",
          status: "running",
          userStatus: "working",
          timestamp: 3,
        } satisfies TaskUpdate,
      },
      message("assistant", "Let me search for the latest US stock market information.", 4),
      task("turn-new:market", "美股 2026年7月2日 行情回顾", "completed", 5, "turn-new"),
      tool("turn-new-search", "web_search", 6, "turn-new", "success", {
        intent: "US stock market July 2 2026 recap summary",
      }),
      message("assistant", "7月2日（周四）美股行情总结", 7),
    ]);

    expect(renderItems.map((item) => item.kind)).toEqual(["single", "single", "execution", "single"]);
    expect(renderItems[2]?.kind).toBe("execution");
    if (renderItems[2]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[2].block.turnId).toBe("turn-new");
    expect(renderItems[2].block.tasks.map((item) => item.task_id)).toEqual(["turn-new:market"]);
  });

  it("does not leave a completed lifecycle work log after the final answer", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Make an HTML report", 1),
      message("assistant", "The report is ready.", 2),
      {
        type: "task_update",
        timestamp: 3,
        data: {
          id: "task-responding",
          task_id: "turn-report:responding",
          turnId: "turn-report",
          title: "Response prepared",
          status: "completed",
          userStatus: "responding",
          timestamp: 3,
        } satisfies TaskUpdate,
      },
    ]);

    expect(renderItems).toHaveLength(2);
    expect(renderItems.map((item) => item.kind)).toEqual(["single", "single"]);
    expect(renderItems[1]?.kind).toBe("single");
    if (renderItems[1]?.kind !== "single") throw new Error("expected assistant message");
    expect(renderItems[1].item).toMatchObject({
      type: "message",
      data: expect.objectContaining({ role: "assistant", content: "The report is ready." }),
    });
  });

  it("still shows a real issue that arrives after an assistant answer", () => {
    const renderItems = buildChatRenderItems([
      message("user", "Make an HTML report", 1),
      message("assistant", "The report is ready.", 2),
      {
        type: "task_update",
        timestamp: 3,
        data: {
          id: "task-responding",
          task_id: "turn-report:responding",
          turnId: "turn-report",
          title: "Response prepared",
          status: "failed",
          userStatus: "responding",
          detail: "Artifact preview could not load",
          timestamp: 3,
        } satisfies TaskUpdate,
      },
    ]);

    expect(renderItems).toHaveLength(3);
    expect(renderItems[2]?.kind).toBe("execution");
    if (renderItems[2]?.kind !== "execution") throw new Error("expected execution block");
    expect(renderItems[2].block.status).toBe("error");
    expect(renderItems[2].block.issueCount).toBe(1);
  });
});
