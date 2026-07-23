import { fireEvent, renderWithLocale, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "@/types";
import ApprovalCard from "./ApprovalCard";

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    description: "This session needs more access.",
    status: "pending",
    timestamp: 1,
    action: "permission_elevation",
    current_level: "L1_READ_WRITE",
    required_level: "L3_FULL_ACCESS",
    denied_action: "network.request",
    tool: "web_search",
    ...overrides,
  };
}

describe("ApprovalCard", () => {
  it("renders a concise action while keeping runtime details collapsed in English", () => {
    renderWithLocale(<ApprovalCard request={request()} onApprove={vi.fn()} onReject={vi.fn()} />, { locale: "en" });

    expect(screen.getByText("Search the web")).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByTestId("approval-technical-details")).toHaveTextContent("Runtime permission: L1 → L3");
    expect(screen.queryByText("Approval Required")).not.toBeInTheDocument();
  });

  it("renders the compact action in Chinese", () => {
    renderWithLocale(<ApprovalCard request={request()} onApprove={vi.fn()} onReject={vi.fn()} />, { locale: "zh-CN" });

    expect(screen.getByText("搜索网络")).toBeInTheDocument();
    expect(screen.getByText("详情")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "更多授权选项" })).toBeInTheDocument();
  });

  it("lets the user choose once or Full access from the pending card", async () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    renderWithLocale(<ApprovalCard request={request()} onApprove={onApprove} onReject={onReject} />, { locale: "en" });

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "More approval options" }));
    fireEvent.click(await screen.findByText("Allow for this session"));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(onApprove).toHaveBeenCalledWith("approval-1", "once");
    expect(onApprove).toHaveBeenCalledWith("approval-1", "session");
    expect(onReject).toHaveBeenCalledWith("approval-1");
  });

  it("sends scope=session when the session scope button is clicked (write_confirmation)", async () => {
    const onApprove = vi.fn();
    renderWithLocale(
      <ApprovalCard
        request={request({ action: "write_confirmation" })}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
      { locale: "en" },
    );

    fireEvent.click(screen.getByRole("button", { name: "More approval options" }));
    fireEvent.click(await screen.findByText("Allow for this session"));

    expect(onApprove).toHaveBeenCalledWith("approval-1", "session");
  });

  it("sends scope=once when the allow-once scope button is clicked (write_confirmation)", () => {
    const onApprove = vi.fn();
    renderWithLocale(
      <ApprovalCard
        request={request({ action: "write_confirmation" })}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
      { locale: "en" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));

    expect(onApprove).toHaveBeenCalledWith("approval-1", "once");
  });

  it("sends scope=session for path_scope_grant session button", async () => {
    const onApprove = vi.fn();
    renderWithLocale(
      <ApprovalCard
        request={request({ action: "path_scope_grant" })}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
      { locale: "en" },
    );

    fireEvent.click(screen.getByRole("button", { name: "More approval options" }));
    fireEvent.click(await screen.findByText("Allow for this session"));

    expect(onApprove).toHaveBeenCalledWith("approval-1", "session");
  });

  it("permission elevation sends the selected access scope", async () => {
    const onApprove = vi.fn();
    renderWithLocale(
      <ApprovalCard request={request({ action: "permission_elevation" })} onApprove={onApprove} onReject={vi.fn()} />,
      { locale: "en" },
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow once" }));
    fireEvent.click(screen.getByRole("button", { name: "More approval options" }));
    fireEvent.click(await screen.findByText("Allow for this session"));

    expect(onApprove).toHaveBeenCalledWith("approval-1", "once");
    expect(onApprove).toHaveBeenCalledWith("approval-1", "session");
  });

  it("collapses to a single quiet line once resolved", () => {
    renderWithLocale(
      <ApprovalCard request={request({ status: "approved" })} onApprove={vi.fn()} onReject={vi.fn()} />,
      { locale: "en" },
    );

    // Compact resolved line, no standing card chrome or action buttons.
    expect(screen.getByTestId("approval-resolved-line")).toBeInTheDocument();
    expect(screen.queryByTestId("approval-card")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow once" })).not.toBeInTheDocument();
    expect(screen.getByTestId("approval-resolved-line")).toHaveTextContent("Approved");
  });
});
