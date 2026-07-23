import { fireEvent, renderWithLocale, screen, waitFor, within } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import DeliverableVersionHistory from "./DeliverableVersionHistory";

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ get: getMock, post: postMock }),
}));

describe("DeliverableVersionHistory", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    getMock.mockResolvedValue({
      data: {
        versions: [
          { id: "dlvv_2", deliverableId: "dlv_1", version: 2, size: 2048, createdAt: new Date().toISOString() },
          { id: "dlvv_1", deliverableId: "dlv_1", version: 1, size: 1024, createdAt: new Date().toISOString() },
        ],
      },
      error: null,
    });
    postMock.mockResolvedValue({ data: { success: true }, error: null });
  });

  it("lists immutable versions and confirms before rolling back", async () => {
    const onRollback = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithLocale(<DeliverableVersionHistory deliverableId="dlv_1" onRollback={onRollback} />);

    expect(await screen.findByText("v2")).toBeInTheDocument();
    expect(screen.getByText("v1")).toBeInTheDocument();
    const versionOneRow = screen.getByText("v1").closest("li");
    expect(versionOneRow).not.toBeNull();
    const rollbackButton = within(versionOneRow!).getByRole("button", { name: "Roll back to this version" });

    fireEvent.click(rollbackButton);
    expect(confirm).toHaveBeenCalledWith("Roll back to v1? The current file will be preserved as a new version.");
    expect(postMock).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    fireEvent.click(rollbackButton);
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/deliverables/dlv_1/rollback", { version: 1 }));
    await waitFor(() => expect(onRollback).toHaveBeenCalledTimes(1));
    expect(getMock).toHaveBeenCalledWith("/api/deliverables/dlv_1/versions");
    confirm.mockRestore();
  });

  it("continues the deliverable in a new session from the detail area", async () => {
    const onOpenSession = vi.fn();
    postMock.mockResolvedValue({ data: { session_id: "session-detail-continuation" }, error: null });
    renderWithLocale(
      <DeliverableVersionHistory deliverableId="dlv_1" onOpenSession={onOpenSession} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Continue in a new chat" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/api/deliverables/dlv_1/continue",
      {},
    ));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("session-detail-continuation"));
  });
});
