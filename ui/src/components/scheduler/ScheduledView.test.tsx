import { fireEvent, screen, waitFor, renderWithLocale } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ScheduledView from "./ScheduledView";

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as Response;
}

describe("ScheduledView", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(jsonResponse({
      tasks: [
        {
          id: "task-ok",
          description: "Morning review",
          schedule_kind: "cron",
          schedule_value: "30 6 * * *",
          handler_type: "daily_summary",
          next_run_at: "2026-07-04T06:30:00.000Z",
          last_status: "ok",
          enabled: 1,
          permission_level: "L2_SHELL_EXEC",
          runs: [{
            id: "run-1", session_id: "session-run-1", scheduled_for: "2026-07-03T06:30:00.000Z",
            trigger_origin: "schedule", status: "completed", started_at: "2026-07-03T06:30:00.000Z",
            completed_at: "2026-07-03T06:31:05.000Z",
          }],
        },
        {
          id: "task-failed",
          name: "Sync digest",
          next_run_at: "2026-07-05T09:00:00.000Z",
          last_status: "failed",
          last_error: "Token expired",
        },
      ],
    }))));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lists scheduled tasks from the scheduler endpoint", async () => {
    const onOpenSession = vi.fn();
    renderWithLocale(<ScheduledView onOpenSession={onOpenSession} />);

    expect(await screen.findByText("Morning review")).toBeInTheDocument();
    expect(screen.getByText("Sync digest")).toBeInTheDocument();
    expect(screen.getAllByText("OK").length).toBeGreaterThan(0);
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Token expired")).toBeInTheDocument();
    expect(screen.getByText("Permission level: L2_SHELL_EXEC")).toBeInTheDocument();
    expect(screen.getAllByText("Next run").length).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledWith(
      "/api/scheduler/tasks",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(screen.getByText("cron: 30 6 * * * · daily_summary")).toBeInTheDocument();
    fireEvent.click(screen.getAllByText("Run history")[0]);
    fireEvent.click(screen.getByRole("link", { name: /Scheduled.*OK.*1m 5s/ }));
    expect(onOpenSession).toHaveBeenCalledWith("session-run-1");
  });

  it("uses semantic dot tokens and opens the active run session", async () => {
    vi.mocked(fetch).mockImplementation((input) => Promise.resolve(jsonResponse(
      String(input).includes("/reminders") ? { reminders: [] } : { tasks: [
        { id: "active", description: "Active", enabled: 1, last_status: "running", runs: [
          { id: "run-active", session_id: "session-live", scheduled_for: "2026-07-22T08:00:00Z", status: "running" },
        ] },
        { id: "success", description: "Success", enabled: 1, last_status: "completed", runs: [] },
        { id: "failure", description: "Failure", enabled: 1, last_status: "failed", runs: [] },
      ] },
    )));
    const onOpenSession = vi.fn();
    renderWithLocale(<ScheduledView onOpenSession={onOpenSession} />);

    const activeDot = await screen.findByTestId("task-status-dot-active");
    expect(activeDot).toHaveClass("bg-activity", "pulse-dot");
    expect(screen.getByTestId("task-status-dot-success")).toHaveStyle({ background: "var(--success)" });
    expect(screen.getByTestId("task-status-dot-failure")).toHaveStyle({ background: "var(--danger)" });
    const liveLink = screen.getByTitle("View live execution");
    expect(liveLink).toHaveAttribute("href", "#/session/session-live");
    expect(liveLink).toHaveTextContent("Running · View live");
    expect(liveLink).toHaveClass("text-activity", "underline", "underline-offset-2");
    expect(liveLink.querySelector("svg")).toBeInTheDocument();
    fireEvent.click(liveLink);
    expect(onOpenSession).toHaveBeenCalledWith("session-live");
  });

  it("renders run history origins, duration, navigation, and its quiet empty state", async () => {
    vi.mocked(fetch).mockImplementation((input) => Promise.resolve(jsonResponse(
      String(input).includes("/reminders") ? { reminders: [] } : { tasks: [
        { id: "history", description: "History", enabled: 1, last_status: "completed", runs: [
          {
            id: "manual", session_id: "session-manual", scheduled_for: "2026-07-22T08:00:00Z",
            trigger_origin: "manual", status: "completed", started_at: "2026-07-22T08:00:00Z",
            completed_at: "2026-07-22T08:00:09Z",
          },
          {
            id: "scheduled", session_id: "session-scheduled", scheduled_for: "2026-07-21T08:00:00Z",
            trigger_origin: "schedule", status: "completed", started_at: "2026-07-21T08:00:00Z",
            completed_at: "2026-07-21T08:01:02Z",
          },
        ] },
        { id: "empty-history", description: "Empty history", enabled: 1, runs: [] },
      ] },
    )));
    const onOpenSession = vi.fn();
    renderWithLocale(<ScheduledView onOpenSession={onOpenSession} />);

    const histories = await screen.findAllByText("Run history");
    fireEvent.click(histories[0]);
    expect(screen.getByText("Manual")).toBeInTheDocument();
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    expect(screen.getByText("9s")).toBeInTheDocument();
    expect(screen.getByText("1m 2s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /Manual.*OK.*9s/ }));
    expect(onOpenSession).toHaveBeenCalledWith("session-manual");

    fireEvent.click(histories[1]);
    expect(screen.getByText("No runs yet.")).toHaveClass("text-ink/36");
  });

  it("pauses and resumes a task through the existing scheduler patch route", async () => {
    let enabled = 1;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        enabled = JSON.parse(String(init.body)).enabled ? 1 : 0;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.includes("/api/scheduler/reminders")) return Promise.resolve(jsonResponse({ reminders: [] }));
      return Promise.resolve(jsonResponse({ tasks: [{
        id: "task-toggle", description: "Toggle report", enabled,
        schedule_kind: "every", schedule_value: "60000",
        next_run_at: enabled ? "2026-07-04T06:30:00.000Z" : null,
      }] }));
    });
    renderWithLocale(<ScheduledView />);

    fireEvent.click(await screen.findByTitle("Pause schedule"));
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByText("Next run").nextElementSibling).toHaveTextContent("");
    expect(fetch).toHaveBeenCalledWith(
      "/api/scheduler/tasks/task-toggle",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    );

    fireEvent.click(screen.getByTitle("Resume schedule"));
    await waitFor(() => expect(screen.queryByText("Paused")).not.toBeInTheDocument());
  });

  it("queues one manual run and disables the action while a run is active", async () => {
    let active = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/run-now")) {
        active = true;
        return Promise.resolve(jsonResponse({ run: { id: "manual-run", trigger_origin: "manual" } }));
      }
      if (url.includes("/api/scheduler/reminders")) return Promise.resolve(jsonResponse({ reminders: [] }));
      return Promise.resolve(jsonResponse({ tasks: [{
        id: "task-manual", description: "Manual report", enabled: 0,
        schedule_kind: "every", schedule_value: "60000",
        last_status: active ? "queued" : "failed",
        runs: active ? [{ id: "manual-run", scheduled_for: "2026-07-22T08:00:00.000Z", status: "queued" }] : [],
      }] }));
    });
    renderWithLocale(<ScheduledView />);

    fireEvent.click(await screen.findByRole("button", { name: "Run once now" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/scheduler/tasks/task-manual/run-now",
      expect.objectContaining({ method: "POST" }),
    ));
    const button = await screen.findByRole("button", { name: "Run once now" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "A run is already active");
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("shows a quiet empty state when no tasks are scheduled", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ tasks: [] }));

    renderWithLocale(<ScheduledView />);

    expect(await screen.findByText("No scheduled tasks yet. Try asking MOZI to prepare a morning briefing every day.")).toBeInTheDocument();
  });

  it.each([
    { locale: "en" as const, label: "Reminded" },
    { locale: "zh-CN" as const, label: "已提醒" },
  ])("hides reminder identifiers and humanizes fired status in $locale", async ({ locale, label }) => {
    const reminderUuid = "8fd7424a-b24f-4cc6-85ea-5c45d6a6dc2d";
    vi.mocked(fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/api/scheduler/reminders")) {
        return Promise.resolve(jsonResponse({
          reminders: [{ id: 1, chat_id: reminderUuid, message: "Stand up", fire_at: "2026-07-04T06:30:00.000Z", fired: 1 }],
        }));
      }
      return Promise.resolve(jsonResponse({ tasks: [] }));
    });

    renderWithLocale(<ScheduledView />, { locale });

    expect(await screen.findByText(label, {}, { timeout: 1500 })).toBeInTheDocument();
    expect(screen.queryByText(reminderUuid)).not.toBeInTheDocument();
  });

  it("creates reminders without a hard-coded chat identity", async () => {
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (init?.method === "POST" && url.includes("/api/scheduler/reminders")) {
        return Promise.resolve(jsonResponse({ reminder: { id: 2 } }));
      }
      return Promise.resolve(jsonResponse(url.includes("/api/scheduler/reminders") ? { reminders: [] } : { tasks: [] }));
    });
    renderWithLocale(<ScheduledView />);
    fireEvent.change(await screen.findByPlaceholderText("Reminder message"), { target: { value: "Stretch" } });
    fireEvent.click(screen.getByRole("button", { name: "Add reminder" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/scheduler/reminders",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ message: "Stretch", delayMinutes: 15 }),
      }),
    ));
  });
});
