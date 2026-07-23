import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FilesView, { isLocalFilesOrigin } from "./FilesView";

const getMock = vi.fn();
const postMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({ get: getMock, post: postMock, del: vi.fn() }),
}));

const WORKSPACE_LIST = {
  dir: "/Users/person/Library/Application Support/MOZI/workspaces/3d58f218-0f86-463c-a33f-7cc3a8de8a53",
  root: "/Users/person/Library/Application Support/MOZI/workspaces/3d58f218-0f86-463c-a33f-7cc3a8de8a53",
  entries: [],
};

/** Route the two GET endpoints; tests override `list` per case. */
function stubApi(options?: {
  list?: (url: string) => unknown;
  deliverables?: unknown;
  source?: unknown;
}) {
  getMock.mockImplementation((url: string) => {
    if (url.startsWith("/api/fs/deliverables")) {
      return Promise.resolve({ data: options?.deliverables ?? { groups: [] }, error: null });
    }
    if (url.startsWith("/api/fs/source")) {
      return Promise.resolve({ data: options?.source ?? { source: null }, error: null });
    }
    return Promise.resolve({ data: options?.list ? options.list(url) : WORKSPACE_LIST, error: null });
  });
}

/** The browser is the SECOND page now — deliverables land first. */
async function gotoBrowse() {
  fireEvent.click(await screen.findByRole("tab", { name: "Folders" }));
}

describe("FilesView", () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    postMock.mockResolvedValue({ data: { success: true }, error: null });
    stubApi();
  });

  it("lands on the deliverables library, grouped by conversation with real titles", async () => {
    const onOpenSession = vi.fn();
    stubApi({
      deliverables: {
        groups: [
          {
            sessionId: "session-1",
            sessionTitle: "美债宏观报告",
            latestTimestamp: Date.now(),
            deliverables: [
              { artifactId: "a1", path: "/o/Bond_Report.pdf", filename: "Bond_Report.pdf", size: 1000, timestamp: Date.now(), role: "primary", kind: "document", ext: "pdf" },
              { artifactId: "a2", path: "/o/chart1.png", filename: "chart1.png", size: 50, timestamp: Date.now(), role: "supporting", kind: "image", ext: "png" },
            ],
          },
        ],
      },
    });
    renderWithLocale(<FilesView onOpenSession={onOpenSession} />);

    // Session title — never a UUID — names the group.
    expect(await screen.findByText("美债宏观报告")).toBeInTheDocument();
    expect(screen.getByText("Bond_Report.pdf")).toBeInTheDocument();
    // Supporting files sit behind a disclosure, not beside the deliverable.
    expect(screen.queryByText("chart1.png")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /1 working file/ }));
    expect(screen.getByText("chart1.png")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open conversation" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-1");
  });

  it("opens a registered Files deliverable with its stable version identity", async () => {
    const onOpenArtifact = vi.fn();
    stubApi({
      deliverables: {
        groups: [{
          sessionId: "session-versioned",
          sessionTitle: "Versioned work",
          latestTimestamp: Date.now(),
          deliverables: [{
            artifactId: "artifact-versioned",
            path: "/o/Versioned.pdf",
            filename: "Versioned.pdf",
            size: 42,
            timestamp: Date.now(),
            role: "primary",
            kind: "document",
            ext: "pdf",
            deliverableId: "dlv_versioned",
            versionCount: 2,
          }],
        }],
      },
    });
    renderWithLocale(<FilesView onOpenArtifact={onOpenArtifact} />);

    fireEvent.click(await screen.findByText("Versioned.pdf"));

    expect(onOpenArtifact).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ deliverableId: "dlv_versioned" }),
    }));
  });

  it("creates a continuation session for a registered deliverable and navigates to it", async () => {
    const onOpenSession = vi.fn();
    postMock.mockResolvedValue({ data: { session_id: "session-continuation" }, error: null });
    stubApi({
      deliverables: {
        groups: [{
          sessionId: "session-source",
          sessionTitle: "Source work",
          latestTimestamp: Date.now(),
          deliverables: [{
            artifactId: "artifact-continuation",
            path: "/o/Continuation.pdf",
            filename: "Continuation.pdf",
            size: 42,
            timestamp: Date.now(),
            role: "primary",
            kind: "document",
            ext: "pdf",
            deliverableId: "dlv_continuation",
            versionCount: 2,
          }],
        }],
      },
    });
    renderWithLocale(<FilesView onOpenSession={onOpenSession} />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue in a new chat" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith(
      "/api/deliverables/dlv_continuation/continue",
      {},
    ));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith("session-continuation"));
  });

  it("shows the quiet empty state when nothing was delivered yet", async () => {
    renderWithLocale(<FilesView />);
    expect(await screen.findByText(/Nothing delivered yet/)).toBeInTheDocument();
    // No folder chrome on the library page.
    expect(screen.queryByTestId("files-root-switcher")).not.toBeInTheDocument();
  });

  it("switches between the workspace, the output shelf, and the same project roots the composer uses", async () => {
    const roots = [
      { kind: "workspace", path: "/workspace", label: "Workspace", exists: true },
      { kind: "output", path: "/mozi/output", label: "Deliverables", exists: true },
      { kind: "project_root", path: "/Users/person/codes/OpenMoziDemo", label: "OpenMoziDemo", exists: true },
    ] as never;
    stubApi({
      list: (url: string) => {
        if (url.includes(encodeURIComponent("/Users/person/codes/OpenMoziDemo"))) {
          return { dir: "/Users/person/codes/OpenMoziDemo", root: "/Users/person/codes/OpenMoziDemo", entries: [
            { name: "Cargo.toml", path: "/Users/person/codes/OpenMoziDemo/Cargo.toml", isDir: false, size: 5, mtime: 1, artifactKind: "other" },
          ] };
        }
        if (url.includes(encodeURIComponent("/mozi/output"))) {
          return { dir: "/mozi/output", root: "/mozi/output", entries: [
            { name: "final.pdf", path: "/mozi/output/final.pdf", isDir: false, size: 20, mtime: 2, artifactKind: "document" },
          ] };
        }
        return { dir: "/workspace", root: "/workspace", entries: [] };
      },
    });
    renderWithLocale(<FilesView roots={roots} />);
    await gotoBrowse();

    const switcher = await screen.findByTestId("files-root-switcher");
    const projectChip = screen.getByRole("button", { name: "OpenMoziDemo" });
    expect(switcher).toContainElement(projectChip);

    // The output shelf finally has a Files-nav home (operator report 2026-07-19).
    fireEvent.click(screen.getByRole("button", { name: "Output" }));
    expect(await screen.findByText("final.pdf")).toBeInTheDocument();

    fireEvent.click(projectChip);
    expect(await screen.findByText("Cargo.toml")).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent("/Users/person/codes/OpenMoziDemo")));

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(screen.queryByText("Cargo.toml")).not.toBeInTheDocument());
  });

  it("reveals the absolute workspace location only on request", async () => {
    renderWithLocale(<FilesView />);
    await gotoBrowse();
    const path = "/Users/person/Library/Application Support/MOZI/workspaces/3d58f218-0f86-463c-a33f-7cc3a8de8a53";

    const reveal = await screen.findByRole("button", { name: "Show location" });
    expect(screen.queryByText(path)).not.toBeInTheDocument();
    fireEvent.click(reveal);
    expect(screen.getByText(path)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Hide location" }));
    expect(screen.queryByText(path)).not.toBeInTheDocument();
  });

  it("lists code files flat — the regex working-files split is gone", async () => {
    // Deliverable-vs-working is answered by the Deliverables page from
    // artifact-role truth; the browser shows the folder as it is.
    stubApi({
      list: () => ({ dir: "/workspace", root: "/workspace", entries: [
        { name: "source.ts", path: "/workspace/source.ts", isDir: false, size: 10, mtime: 1, artifactKind: "code" },
        { name: "final.pdf", path: "/workspace/final.pdf", isDir: false, size: 20, mtime: 2, artifactKind: "document" },
        { name: "Reports", path: "/workspace/Reports", isDir: true, mtime: 3 },
      ] }),
    });
    renderWithLocale(<FilesView />);
    await gotoBrowse();

    expect(await screen.findByText("Reports")).toBeInTheDocument();
    expect(screen.getByText("final.pdf")).toBeInTheDocument();
    expect(screen.getByText("source.ts")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Working files/ })).not.toBeInTheDocument();
  });

  it("navigates deep folders with a clickable breadcrumb trail", async () => {
    stubApi({
      list: (url: string) => {
        if (url.includes(encodeURIComponent("/workspace/reports/2026"))) {
          return { dir: "/workspace/reports/2026", root: "/workspace", entries: [] };
        }
        if (url.includes(encodeURIComponent("/workspace/reports"))) {
          return { dir: "/workspace/reports", root: "/workspace", entries: [
            { name: "2026", path: "/workspace/reports/2026", isDir: true, mtime: 2 },
          ] };
        }
        return { dir: "/workspace", root: "/workspace", entries: [
          { name: "reports", path: "/workspace/reports", isDir: true, mtime: 1 },
        ] };
      },
    });
    renderWithLocale(<FilesView />);
    await gotoBrowse();

    fireEvent.click(await screen.findByText("reports"));
    fireEvent.click(await screen.findByText("2026"));
    const crumbs = await screen.findByTestId("files-breadcrumbs");
    expect(crumbs).toHaveTextContent("Workspace");
    expect(crumbs).toHaveTextContent("reports");
    expect(crumbs).toHaveTextContent("2026");

    // Jump straight back to the root — no Up-click ladder.
    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    await waitFor(() => expect(screen.getByTestId("files-breadcrumbs")).not.toHaveTextContent("2026"));
  });

  it("keeps search results flat and exposes file details with source-chat navigation", async () => {
    const onOpenSession = vi.fn();
    stubApi({
      list: () => ({ dir: "/workspace", root: "/workspace", entries: [
        { name: "source.ts", path: "/workspace/source.ts", isDir: false, size: 10, created: 1000, mtime: 2000, artifactKind: "code" },
      ] }),
      source: { source: { sessionId: "session-1", sessionTitle: "Launch plan", timestamp: 5 } },
    });
    renderWithLocale(<FilesView onOpenSession={onOpenSession} />);
    await gotoBrowse();

    fireEvent.change(await screen.findByPlaceholderText("Search files"), { target: { value: "source" } });
    fireEvent.click(screen.getByRole("button", { name: /source.ts/ }));
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/fs/source?path=%2Fworkspace%2Fsource.ts"));
    fireEvent.click(await screen.findByRole("button", { name: "From chat: Launch plan" }));
    expect(onOpenSession).toHaveBeenCalledWith("session-1");
    expect(screen.getAllByText("source.ts")).toHaveLength(2);
  });

  it("calls reveal from a card's overflow menu and identifies remote origins", async () => {
    stubApi({
      list: () => ({ dir: "/workspace", root: "/workspace", entries: [
        { name: "final.pdf", path: "/workspace/final.pdf", isDir: false, size: 20, mtime: 2, artifactKind: "document" },
      ] }),
    });
    renderWithLocale(<FilesView />);
    await gotoBrowse();
    // Grid form: per-tile actions live behind the overflow menu (operator
    // decision 2026-07-19 — a folder system, not a checkbox table).
    fireEvent.click(await screen.findByRole("button", { name: "Actions" }));
    expect(screen.getByTestId("files-entry-menu")).toBeInTheDocument();
    fireEvent.click(await screen.findByTitle(/Reveal in Finder|Show in folder/));
    // The menu closes after the action fires.
    expect(screen.queryByTestId("files-entry-menu")).not.toBeInTheDocument();
    expect(postMock).toHaveBeenCalledWith("/api/fs/reveal", { path: "/workspace/final.pdf" });
    expect(isLocalFilesOrigin("files.example.com")).toBe(false);
    expect(isLocalFilesOrigin("127.0.0.1")).toBe(true);
  });
});
