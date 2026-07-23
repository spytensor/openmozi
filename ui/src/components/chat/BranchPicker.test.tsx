import { fireEvent, screen, waitFor, within, renderWithLocale } from "@/test/render";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeWorkspaceRoot } from "@/types/runtime";
import { BranchPicker, isLikelyValidBranchName } from "./BranchPicker";

const repoRoot: RuntimeWorkspaceRoot = {
  id: "project_root:/Users/test/Repo",
  kind: "project_root",
  label: "Repo",
  path: "/Users/test/Repo",
  exists: true,
  git: { is_repo: true, branch: "main" },
};

function branchesPayload(overrides?: Partial<Record<string, unknown>>) {
  return {
    success: true,
    current: { branch: "main", detached: false, sha: "abc1234" },
    dirty_count: 0,
    is_runtime_source: false,
    branches: [
      { name: "main", last_commit_at: "2026-07-13T00:00:00+04:00", subject: "init", is_current: true },
      { name: "feature/demo", last_commit_at: "2026-07-12T00:00:00+04:00", subject: "wip", is_current: false },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/git/branches")) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(branchesPayload()) } as Response);
    }
    if (url === "/api/git/switch") {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, branch: "feature/demo", previous: "main" }) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BranchPicker chip (trigger)", () => {
  it("shows the branch name for a repo root", () => {
    renderWithLocale(<BranchPicker root={repoRoot} open={false} onOpenChange={() => {}} />);
    expect(screen.getByTestId("branch-chip")).toHaveTextContent("main");
  });

  it("shows the short sha on detached HEAD", () => {
    renderWithLocale(
      <BranchPicker root={{ ...repoRoot, git: { is_repo: true, detached_sha: "abc1234" } }} open={false} onOpenChange={() => {}} />,
    );
    expect(screen.getByTestId("branch-chip")).toHaveTextContent("abc1234");
  });

  it("does not fetch branches until the popover is opened", () => {
    renderWithLocale(<BranchPicker root={repoRoot} open={false} onOpenChange={() => {}} />);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/api/git/branches"), expect.anything());
  });
});

describe("BranchPicker panel (open)", () => {
  it("fetches branches for the root and renders them, current pinned with a check", async () => {
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} />, { locale: "en" });

    await waitFor(() => expect(screen.getByText("feature/demo")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/git/branches?root=${encodeURIComponent(repoRoot.path)}`,
      expect.anything(),
    );
    const rows = screen.getAllByRole("button").filter((b) => b.textContent?.match(/main|feature\/demo/));
    expect(rows[0]).toHaveTextContent("main");
  });

  it("switches a clean tree directly, refreshes roots, and closes the popover", async () => {
    const onOpenChange = vi.fn();
    const onRootsChanged = vi.fn().mockResolvedValue(undefined);
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={onOpenChange} onRootsChanged={onRootsChanged} />, { locale: "en" });

    fireEvent.click(await screen.findByText("feature/demo"));

    await waitFor(() => expect(onRootsChanged).toHaveBeenCalledOnce());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/git/switch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ root: repoRoot.path, branch: "feature/demo" }),
      }),
    );
  });

  it("asks for confirmation when the tree is dirty; cancel does not POST", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/git/branches")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(branchesPayload({ dirty_count: 3 })) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) } as Response);
    });
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} />, { locale: "en" });

    fireEvent.click(await screen.findByText("feature/demo"));
    expect(await screen.findByText("Switch branch with uncommitted changes?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/git/switch", expect.anything());
  });

  it("confirms a dirty switch and then POSTs", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/git/branches")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(branchesPayload({ dirty_count: 1 })) } as Response);
      }
      if (url === "/api/git/switch") {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, branch: "feature/demo" }) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    const onRootsChanged = vi.fn().mockResolvedValue(undefined);
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} onRootsChanged={onRootsChanged} />, { locale: "en" });

    fireEvent.click(await screen.findByText("feature/demo"));
    fireEvent.click(await screen.findByRole("button", { name: "Switch" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/git/switch", expect.objectContaining({ method: "POST" })),
    );
    await waitFor(() => expect(onRootsChanged).toHaveBeenCalledOnce());
  });

  it("shows git's stderr verbatim on a 409", async () => {
    const stderr = "error: Your local changes to the following files would be overwritten by checkout:\n\tbase.txt";
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/git/branches")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(branchesPayload()) } as Response);
      }
      if (url === "/api/git/switch") {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ success: false, error: stderr }) } as Response);
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
    });
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} />, { locale: "en" });

    fireEvent.click(await screen.findByText("feature/demo"));

    const errorBox = await screen.findByTestId("branch-switch-error");
    expect(errorBox).toHaveTextContent("would be overwritten");
  });

  it("creates a branch via the create flow with create: true", async () => {
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} onRootsChanged={vi.fn()} />, { locale: "en" });

    fireEvent.click(await screen.findByText("Create and checkout new branch..."));
    fireEvent.change(screen.getByPlaceholderText("New branch name"), { target: { value: "feature/next" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/git/switch",
        expect.objectContaining({
          body: JSON.stringify({ root: repoRoot.path, branch: "feature/next", create: true }),
        }),
      ),
    );
  });

  it("blocks an invalid new branch name locally", async () => {
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} />, { locale: "en" });

    fireEvent.click(await screen.findByText("Create and checkout new branch..."));
    fireEvent.change(screen.getByPlaceholderText("New branch name"), { target: { value: "-bad" } });

    expect(screen.getByText("Invalid branch name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/git/switch", expect.anything());
  });

  it("filters branches with the search box", async () => {
    renderWithLocale(<BranchPicker root={repoRoot} open onOpenChange={() => {}} />, { locale: "en" });

    await screen.findByText("feature/demo");
    fireEvent.change(screen.getByPlaceholderText("Search branches..."), { target: { value: "demo" } });

    // Scope to the panel — "main" still shows in the chip (trigger), which is
    // outside the popover content.
    const panel = screen.getByTestId("branch-picker");
    expect(within(panel).queryByText("main")).not.toBeInTheDocument();
    expect(within(panel).getByText("feature/demo")).toBeInTheDocument();
  });
});

describe("isLikelyValidBranchName", () => {
  it("matches backend rules on representative cases", () => {
    expect(isLikelyValidBranchName("feature/x")).toBe(true);
    expect(isLikelyValidBranchName("-f")).toBe(false);
    expect(isLikelyValidBranchName("a..b")).toBe(false);
    expect(isLikelyValidBranchName("a b")).toBe(false);
    expect(isLikelyValidBranchName("a.lock")).toBe(false);
  });
});
