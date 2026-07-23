import { fireEvent, screen, renderWithLocale } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminShell from "./AdminShell";

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const patchMock = vi.fn();
const delMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ get: getMock, post: postMock, put: putMock, patch: patchMock, del: delMock }),
}));

describe("AdminShell", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    putMock.mockReset();
    patchMock.mockReset();
    delMock.mockReset();
    getMock.mockResolvedValue({ data: null, error: null });
  });

  it("renders the shell nav sections", () => {
    renderWithLocale(<AdminShell currentUser={viewerUser} onBackToWorkspace={vi.fn()} />);

    expect(screen.getByTestId("admin-shell")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();
    expect(screen.queryByTestId("mozi-avatar")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Audit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Usage & Quotas" })).toBeInTheDocument();
  });

  it("calls the back callback", () => {
    const onBackToWorkspace = vi.fn();
    renderWithLocale(<AdminShell currentUser={viewerUser} onBackToWorkspace={onBackToWorkspace} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to workspace" }));

    expect(onBackToWorkspace).toHaveBeenCalledTimes(1);
  });

  it("owns vertical scrolling in the constrained admin content region", () => {
    renderWithLocale(<AdminShell currentUser={adminUser} onBackToWorkspace={vi.fn()} />);

    const scrollRegion = screen.getByTestId("admin-scroll-region");
    expect(scrollRegion.className).toContain("overflow-y-auto");
    expect(scrollRegion.className).toContain("min-h-0");
    expect(scrollRegion.parentElement?.className).toContain("flex");
    expect(scrollRegion.parentElement?.className).toContain("overflow-hidden");
  });

  it("renders the permission fallback for non-admin users", () => {
    renderWithLocale(<AdminShell currentUser={viewerUser} onBackToWorkspace={vi.fn()} />);

    expect(screen.getByTestId("admin-permission-state")).toBeInTheDocument();
    expect(screen.getByText("Insufficient permissions")).toBeInTheDocument();
    expect(getMock).not.toHaveBeenCalled();
  });
});

const adminUser = {
  id: "admin-1",
  tenant_id: "default",
  email: "admin@example.com",
  name: "Admin User",
  role: "admin" as const,
  status: "active" as const,
};

const viewerUser = {
  ...adminUser,
  role: "viewer" as const,
};
