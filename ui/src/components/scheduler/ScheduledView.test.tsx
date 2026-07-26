import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScheduledView from "./ScheduledView";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

const PROMPT_ITEM = {
  id: "task:task-ok",
  kind: "prompt",
  body: "Morning review",
  schedule: { kind: "cron", value: "30 6 * * *" },
  status: "ok",
  nextRunAt: "2026-07-04T06:30:00.000Z",
  runCount: 3,
  permissionLevel: "L2_SHELL_EXEC",
  canPause: true,
  canRunNow: true,
  runs: [{
    id: "run-1",
    session_id: "session-run-1",
    scheduled_for: "2026-07-03T06:30:00.000Z",
    trigger_origin: "schedule",
    status: "completed",
    started_at: "2026-07-03T06:30:00.000Z",
    completed_at: "2026-07-03T06:31:05.000Z",
  }],
};

const FAILED_ITEM = {
  id: "task:task-failed",
  kind: "prompt",
  body: "Sync digest",
  schedule: { kind: "cron", value: "15 15 * * 1-5" },
  status: "failed",
  nextRunAt: "2026-07-05T09:00:00.000Z",
  runCount: 1,
  error: "Token expired",
  canPause: true,
  canRunNow: true,
};

const REMINDER_ITEM = {
  id: "reminder:7",
  kind: "reminder",
  body: "Stand up",
  schedule: { kind: "at", value: "2026-07-05T09:00:00.000Z" },
  status: "scheduled",
  nextRunAt: "2026-07-05T09:00:00.000Z",
  runCount: 0,
  permissionLevel: null,
  canPause: false,
  canRunNow: false,
};

function stubItems(items: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({ items }))));
}

describe("ScheduledView", () => {
  beforeEach(() => stubItems([PROMPT_ITEM, FAILED_ITEM, REMINDER_ITEM]));
  afterEach(() => vi.unstubAllGlobals());

  it("lists prompts and reminders together, from one endpoint", async () => {
    renderWithLocale(<ScheduledView />);
    expect(await screen.findByText("Morning review")).toBeInTheDocument();
    expect(screen.getByText("Sync digest")).toBeInTheDocument();
    // A reminder is a row in the same list, not a separate section with its own
    // form bolted underneath.
    expect(screen.getByText("Stand up")).toBeInTheDocument();

    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
    expect(calls.some(url => url.includes("/api/scheduler/items"))).toBe(true);
    expect(calls.some(url => url.includes("/api/scheduler/reminders"))).toBe(false);
  });

  it("describes the schedule in words and keeps runtime identifiers off the card", async () => {
    renderWithLocale(<ScheduledView />);
    expect(await screen.findByText("Daily at 06:30")).toBeInTheDocument();
    expect(screen.getByText("Weekdays at 15:15")).toBeInTheDocument();
    // The old card led with the raw expression and the internal handler id.
    expect(screen.queryByText(/cron: 30 6/)).not.toBeInTheDocument();
    expect(screen.queryByText(/managed_brain|daily_summary/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Permission level:/)).not.toBeInTheDocument();
  });

  it("states why the last run failed instead of hiding it behind a markerless disclosure", async () => {
    renderWithLocale(<ScheduledView />);
    // Previously this text lived inside a <summary> with `list-none`, so it was
    // rendered but had no affordance saying it could be opened.
    expect(await screen.findByText("Token expired")).toBeVisible();
    expect(screen.getByText("Last run failed")).toBeVisible();
  });

  it("offers no pause or run-now on a reminder, because neither means anything", async () => {
    renderWithLocale(<ScheduledView />);
    await screen.findByText("Stand up");
    // Two prompts carry both controls; the reminder carries neither.
    expect(screen.getAllByTitle("Run once now")).toHaveLength(2);
    expect(screen.getAllByTitle("Pause schedule")).toHaveLength(2);
    expect(screen.getAllByTitle("Delete task")).toHaveLength(3);
  });

  it("uses semantic status tokens for the dots", async () => {
    renderWithLocale(<ScheduledView />);
    await screen.findByText("Morning review");
    expect(screen.getByTestId("task-status-dot-task:task-ok")).toHaveStyle({ background: "var(--success)" });
    expect(screen.getByTestId("task-status-dot-task:task-failed")).toHaveStyle({ background: "var(--danger)" });
  });

  it("mutates through the unified item routes", async () => {
    renderWithLocale(<ScheduledView />);
    await screen.findByText("Morning review");
    fireEvent.click(screen.getAllByTitle("Pause schedule")[0]);
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map(call => String(call[0]));
      expect(calls.some(url => url.includes("/api/scheduler/items/task%3Atask-ok"))).toBe(true);
    });
  });

  it("teaches with templates when nothing is scheduled, and opens the composer prefilled", async () => {
    stubItems([]);
    renderWithLocale(<ScheduledView />);
    // The empty state used to be one line that explained nothing.
    expect(await screen.findByText("Weekly repo report")).toBeInTheDocument();
    expect(screen.getByText("Research digest")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Weekly repo report"));
    const body = await screen.findByRole("textbox");
    // A template is a draft to edit, never something that runs on one click.
    expect((body as HTMLTextAreaElement).value).toContain("merged pull requests");
  });

  it("still offers templates once the list is no longer empty", async () => {
    // They used to be gated on an empty list, so they were a first-run tutorial
    // that vanished the moment you had one task — exactly when "add another"
    // makes an example most useful. They belong to the act of creating.
    renderWithLocale(<ScheduledView />);
    await screen.findByText("Morning review");
    expect(screen.queryByText("Weekly repo report")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("New"));
    expect(await screen.findByText("Weekly repo report")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Morning market brief"));
    const body = await screen.findByRole("textbox");
    expect((body as HTMLTextAreaElement).value).toContain("yesterday's close");
    // Once there is something to schedule, the examples get out of the way.
    expect(screen.queryByText("Weekly repo report")).not.toBeInTheDocument();
  });

  // NOTE: the Escape half of this is verified in jsdom only. In the packaged app
  // the automation harness cannot deliver Escape to the renderer at all — the
  // long-standing handler in SettingsView does not fire under it either — so
  // this path is unproven on a real keystroke.
  it("keeps the way out reachable, and takes it on Escape", async () => {
    // Cancel used to render after the ten example cards, so with a blank body it
    // sat below the fold — changing your mind meant scrolling past everything to
    // find the exit.
    stubItems([]);
    renderWithLocale(<ScheduledView />);
    fireEvent.click(await screen.findByText("New"));

    const cancel = await screen.findByText("Cancel");
    const examples = screen.getByText("Weekly repo report");
    // Cancel must come before the examples in document order.
    expect(cancel.compareDocumentPosition(examples) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Dispatch on the field that actually has focus, so this exercises the real
    // bubbling path. Firing straight at `window` would pass even if something
    // between the textarea and the listener swallowed the key.
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape", bubbles: true });
    await waitFor(() => expect(screen.queryByText("Cancel")).not.toBeInTheDocument());
  });

  it("closes the composer when Cancel is clicked", async () => {
    stubItems([]);
    renderWithLocale(<ScheduledView />);
    fireEvent.click(await screen.findByText("New"));
    fireEvent.click(await screen.findByText("Cancel"));
    await waitFor(() => expect(screen.queryByText("Schedule it")).not.toBeInTheDocument());
  });

  it("opens an empty composer from the header, which the page never had before", async () => {
    stubItems([]);
    renderWithLocale(<ScheduledView />);
    fireEvent.click(await screen.findByText("New"));
    const body = await screen.findByRole("textbox");
    expect((body as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByText("Schedule it")).toBeInTheDocument();
  });
});
