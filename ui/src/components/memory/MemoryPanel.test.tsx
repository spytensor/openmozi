import { fireEvent, renderWithLocale, screen, waitFor } from "@/test/render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MemoryPanel from "./MemoryPanel";

const getMock = vi.fn();
const patchMock = vi.fn();

vi.mock("@/hooks/useApi", () => ({
  useApi: () => ({
    get: getMock,
    post: vi.fn(),
    patch: patchMock,
    del: vi.fn(),
  }),
}));

describe("MemoryPanel", () => {
  beforeEach(() => {
    getMock.mockReset();
    patchMock.mockReset();
    patchMock.mockResolvedValue({ data: {}, error: null });
    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/memory/facts") return { data: null, error: "database disk image is malformed" };
      if (path === "/api/memory/digests") return { data: { digests: [] }, error: null };
      if (path === "/api/memory/status") return {
        data: {
          recall_strategy: "hybrid",
          search_mode: "local_fts",
          semantic_enabled: false,
          semantic_available: true,
          embedding_provider: "openai",
          embedding_model: "text-embedding-3-small",
          activation_threshold: 100,
          fact_count: 9,
          reason: "below_semantic_activation_threshold",
        },
        error: null,
      };
      return { data: null, error: "unexpected endpoint" };
    });
  });

  it("shows an exclusive retryable error instead of a false empty state", async () => {
    renderWithLocale(<MemoryPanel />);

    expect(await screen.findByText(/database disk image is malformed/i)).toBeInTheDocument();
    expect(screen.queryByText("No memories yet.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(getMock.mock.calls.filter(([path]) => path === "/api/memory/facts")).toHaveLength(2);
    });
  });

  it("describes local search as active instead of an embedding failure", async () => {
    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/memory/facts") return { data: { facts: [] }, error: null };
      if (path === "/api/memory/digests") return { data: { digests: [] }, error: null };
      if (path === "/api/memory/status") return {
        data: {
          recall_strategy: "hybrid",
          search_mode: "local_fts",
          semantic_enabled: false,
          semantic_available: true,
          embedding_provider: "openai",
          embedding_model: "text-embedding-3-small",
          activation_threshold: 100,
          fact_count: 9,
          reason: "below_semantic_activation_threshold",
        },
        error: null,
      };
      return { data: null, error: "unexpected endpoint" };
    });

    renderWithLocale(<MemoryPanel />);
    expect(await screen.findByText("Local search · 9 memories")).toBeInTheDocument();
    expect(screen.queryByText(/semantic off/i)).not.toBeInTheDocument();
  });

  it("renders scored search hits returned by the memory search API", async () => {
    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/memory/facts") return { data: { facts: [] }, error: null };
      if (path.startsWith("/api/memory/search?")) return {
        data: {
          facts: [{
            fact: {
              id: 18,
              category: "preference",
              key: "report_format",
              value: "User prefers polished HTML reports",
              confidence: 1,
              salience_score: 0.8,
              source: "auto_extract",
              recall_count: 3,
              created_at: "2026-07-08 13:20:00",
              updated_at: "2026-07-08 13:20:00",
            },
            score: 0.99,
          }],
        },
        error: null,
      };
      if (path === "/api/memory/digests") return { data: { digests: [] }, error: null };
      if (path === "/api/memory/status") return { data: null, error: null };
      return { data: null, error: "unexpected endpoint" };
    });

    renderWithLocale(<MemoryPanel />);
    fireEvent.change(screen.getByPlaceholderText("Search memories"), { target: { value: "HTML" } });

    expect(await screen.findByText("User prefers polished HTML reports")).toBeInTheDocument();
    expect(getMock).toHaveBeenCalledWith(expect.stringContaining("/api/memory/search?q=HTML"));
  });

  it("shows quarantined legacy project memory and confirms it explicitly", async () => {
    getMock.mockImplementation(async (path: string) => {
      if (path === "/api/memory/facts") return {
        data: {
          facts: [{
            id: 56,
            chat_id: "__project__",
            user_id: null,
            category: "fact",
            key: "unsafe_claim",
            value: "Legacy assistant-generated project claim",
            confidence: 1,
            salience_score: 0.7,
            source: "project_extraction",
            status: "pending_review",
            origin_kind: "assistant",
            recall_count: 0,
            created_at: "2026-07-14 10:00:00",
            updated_at: "2026-07-14 10:00:00",
          }],
        },
        error: null,
      };
      if (path === "/api/memory/digests") return { data: { digests: [] }, error: null };
      if (path === "/api/memory/status") return { data: null, error: null };
      return { data: null, error: "unexpected endpoint" };
    });

    renderWithLocale(<MemoryPanel />);
    expect(await screen.findByText("Legacy assistant-generated project claim")).toBeInTheDocument();
    expect(screen.getByText("Project memory")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith("/api/memory/facts/56/status", { status: "active" });
    });
  });
});
