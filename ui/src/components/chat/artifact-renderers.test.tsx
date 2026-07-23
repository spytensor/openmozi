import { fireEvent, screen, renderWithLocale, waitFor } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { Artifact } from "@/types";
import { artifactSnippet, artifactTypeLabel, CodeRenderer, DocumentRenderer, FileArtifactRenderer, getArtifactDownload, isMissingFileError, renderArtifactPrintHtml, SourcesRenderer } from "./artifact-renderers";

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "artifact-1",
    plugin_id: "sandpack_v1",
    title: "Preview",
    status: "completed",
    data: {},
    timestamp: 1,
    ...overrides,
  };
}

describe("artifact renderers", () => {
  it("uses the pdfjs LEGACY build in both realms (modern build garbles fonts on Electron)", async () => {
    // Electron's Chromium lacks Math.sumPrecise / Map.prototype.getOrInsertComputed,
    // which the modern pdfjs build calls during embedded-font translation; pdfjs
    // swallows the per-font TypeError and paints raw subset charcodes (garbled
    // CJK/Latin). The legacy build ships its own shims. Guard both import sites.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    // vitest cwd is the ui/ package root; import.meta.url is http-scheme in jsdom.
    const renderer = await readFile(join(process.cwd(), "src/components/chat/artifact-renderers.tsx"), "utf8");
    const worker = await readFile(join(process.cwd(), "src/lib/pdf-worker.ts"), "utf8");

    expect(renderer).toContain('from "pdfjs-dist/legacy/build/pdf.mjs"');
    expect(renderer).not.toMatch(/from "pdfjs-dist";/);
    expect(worker).toContain('import "pdfjs-dist/legacy/build/pdf.worker.mjs"');
  });

  it("renders static HTML directly in an iframe instead of a Sandpack runtime", () => {
    const { container } = renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          data: {
            content_type: "html",
            code: "<!DOCTYPE html><html><body><h1>Report</h1></body></html>",
          },
        })}
        showCode={false}
      />,
    );

    const iframe = container.querySelector("iframe");
    expect(iframe).toBeInTheDocument();
    expect(iframe?.getAttribute("srcdoc")).toContain("<h1>Report</h1>");
    expect(screen.queryByText(/Couldn't connect to server/i)).not.toBeInTheDocument();
  });

  it("recovers historical HTML that was stored as a markdown document", () => {
    const html = '<!DOCTYPE html><html><body><h1>Recovered dashboard</h1></body></html>';
    const historical = artifact({
      plugin_id: "document_v1",
      data: { content_type: "markdown", markdown: html },
    });
    const { container } = renderWithLocale(<CodeRenderer artifact={historical} showCode={false} />);

    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Recovered dashboard");
    expect(artifactTypeLabel(historical)).toBe("HTML");
    expect(getArtifactDownload(historical)).toMatchObject({
      filename: "Preview.html",
      mime: "text/html",
      text: html,
    });
  });

  it("shows a live generation state for running artifacts without code yet", () => {
    renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          status: "running",
          fallback_text: "Generating preview...",
          data: { content_type: "html", code: "" },
        })}
        showCode={false}
      />,
    );

    expect(screen.getByText("Generating preview...")).toBeInTheDocument();
  });

  it("shows a live writing state for running document artifacts before markdown arrives", () => {
    renderWithLocale(
      <DocumentRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          fallback_text: "Writing document...",
          data: { content_type: "markdown", phase: "writing", live_preview: true },
        })}
      />,
    );

    expect(screen.getByText("Writing document...")).toBeInTheDocument();
    expect(screen.getByText("Content will appear here as soon as the model emits renderable output.")).toBeInTheDocument();
  });

  it("renders document markdown links with the shared link rules", () => {
    const doc = artifact({
      plugin_id: "document_v1",
      data: {
        content_type: "markdown",
        markdown: [
          "[Jump to summary](#summary)",
          "# Summary",
          "[HTTP](https://example.com/report)",
          "[CodeBuddy](codebuddy.cn/work)",
          "[Local deck](/Users/x/a.pptx)",
          "| Metric | Value |\n| --- | --- |\n| Coverage | 92% |",
        ].join("\n\n"),
      },
    });

    renderWithLocale(<DocumentRenderer artifact={doc} />);

    const http = screen.getByRole("link", { name: "HTTP" });
    expect(http).toHaveAttribute("href", "https://example.com/report");
    expect(http).toHaveAttribute("target", "_blank");
    expect(http).toHaveAttribute("rel", "noopener noreferrer nofollow");

    const bareDomain = screen.getByRole("link", { name: "CodeBuddy" });
    expect(bareDomain).toHaveAttribute("href", "https://codebuddy.cn/work");
    expect(bareDomain).toHaveAttribute("target", "_blank");

    expect(screen.queryByRole("link", { name: "Local deck" })).not.toBeInTheDocument();
    expect(screen.getByText("Local deck")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-markdown-document")).toHaveClass("mx-auto", "w-full", "max-w-[960px]", "text-[15px]", "leading-[1.7]", "[&_table]:!w-full");
    expect(screen.getByRole("heading", { name: "Summary" })).toHaveAttribute("id", "summary");
    expect(screen.getByRole("link", { name: "Jump to summary" })).toHaveAttribute("href", "#summary");
    expect(screen.getByTestId("artifact-markdown-document").querySelector("[data-markdown-table-frame] table")).toBeInTheDocument();

    const printHtml = renderArtifactPrintHtml(doc) ?? "";
    expect(printHtml).toContain('href="https://example.com/report"');
    expect(printHtml).toContain('href="https://codebuddy.cn/work"');
    expect(printHtml).toContain('target="_blank"');
    expect(printHtml).toContain('rel="noopener noreferrer nofollow"');
    expect(printHtml).not.toContain('href="/Users/x/a.pptx"');
    expect(printHtml).toContain('id="summary"');
    expect(printHtml).toContain('href="#summary"');
    expect(printHtml).toContain('class="markdown-table-frame');
    expect(printHtml).toContain('font-size: 15px');
    expect(printHtml).toContain('max-width: 960px');
    expect(printHtml).toContain('h1 { font-size: 30px; }');
    expect(printHtml).toContain('table { display: block; border-collapse: collapse; width: 100%');
  });

  it("routes a Markdown file preview through the same document reading surface", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve("# File report\n\nReadable content."),
    } as Response)));
    try {
      renderWithLocale(
        <FileArtifactRenderer
          artifact={artifact({
            plugin_id: "file_v1",
            title: "report.md",
            data: {
              path: "/Users/me/MOZI/output/report.md",
              filename: "report.md",
              ext: "md",
              size: 120,
              mime: "text/markdown",
              kind: "document",
              downloadUrl: "/api/fs/file?path=report.md",
              previewable: true,
            },
          })}
        />,
      );

      expect(await screen.findByTestId("file-markdown-document")).toHaveClass("mx-auto", "w-full", "max-w-[960px]", "text-[15px]", "leading-[1.7]", "[&_table]:!w-full");
      expect(screen.getByRole("heading", { name: "File report" })).toHaveAttribute("id", "file-report");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a calm generating state (not raw code) while writing by default", () => {
    const { container } = renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          data: {
            content_type: "html",
            live_preview: true,
            phase: "rendering",
            code: "<!DOCTYPE html><html><body><h1>Half-writ",
          },
        })}
        showCode={false}
      />,
    );

    // A user asking for a deck must NOT be shown raw streaming source by
    // default — a calm generating state, no code, no broken iframe.
    expect(container.querySelector("iframe")).not.toBeInTheDocument();
    expect(container.querySelector('[data-testid="artifact-live-code"]')).not.toBeInTheDocument();
    expect(screen.queryByText(/Half-writ/)).not.toBeInTheDocument();
  });

  it("keeps the opt-in live code view compact by rendering only a capped tail", () => {
    const code = [
      "BEGIN-ONLY",
      ...Array.from({ length: 70 }, (_, index) => `chunk-${index + 1}`),
      "TAIL-ONLY",
    ].join("\n");

    renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          data: {
            content_type: "html",
            live_preview: true,
            phase: "rendering",
            code,
          },
        })}
        showCode={true}
      />,
    );

    expect(screen.getByTestId("artifact-live-code-window")).not.toHaveClass("max-h-[180px]");
    expect(screen.getByTestId("artifact-live-code-counts")).toHaveTextContent("72 lines");
    expect(screen.getByText(/BEGIN-ONLY/)).toBeInTheDocument();
    expect(screen.getByText(/TAIL-ONLY/)).toBeInTheDocument();
  });

  it("lets the user collapse the default-expanded live code view to the source tail", () => {
    const code = [
      "BEGIN-ONLY",
      ...Array.from({ length: 70 }, (_, index) => `chunk-${index + 1}`),
      "TAIL-ONLY",
    ].join("\n");

    renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "running",
          data: {
            content_type: "html",
            live_preview: true,
            phase: "rendering",
            code,
          },
        })}
        showCode={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Collapse" }));

    expect(screen.getByTestId("artifact-live-code-window")).toHaveClass("max-h-[180px]");
    expect(screen.getByRole("button", { name: "Expand" })).toBeInTheDocument();
    expect(screen.queryByText(/BEGIN-ONLY/)).not.toBeInTheDocument();
    expect(screen.getByText(/TAIL-ONLY/)).toBeInTheDocument();
  });

  it("flips from the live stream to the rendered preview once the artifact completes", () => {
    const { container } = renderWithLocale(
      <CodeRenderer
        artifact={artifact({
          plugin_id: "live_work_v1",
          status: "completed",
          data: {
            content_type: "html",
            live_preview: true,
            code: "<!DOCTYPE html><html><body><h1>Done</h1></body></html>",
          },
        })}
        showCode={false}
      />,
    );

    expect(container.querySelector('[data-testid="artifact-live-code"]')).not.toBeInTheDocument();
    expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("<h1>Done</h1>");
  });

  it("uses visible HTML text for artifact card snippets instead of leaking doctype/source boilerplate", () => {
    expect(
      artifactSnippet(artifact({
        data: {
          content_type: "html",
          code: "<!DOCTYPE html><html><head><style>body{}</style></head><body><h1>Investment report</h1><p>Ready to review.</p></body></html>",
        },
      })),
    ).toBe("Investment report Ready to review.");
  });
});

describe("missing deliverable state (2026-07-19)", () => {
  it("routes a missing-flagged file card to the honest notice, never a 404ing preview", () => {
    renderWithLocale(
      <FileArtifactRenderer
        artifact={{
          id: "f1",
          plugin_id: "file_v1",
          title: "report.pdf",
          status: "completed",
          timestamp: 1,
          data: {
            path: "/Users/me/MOZI/output/report.pdf",
            filename: "report.pdf",
            ext: "pdf",
            size: 100,
            mime: "application/pdf",
            kind: "document",
            downloadUrl: "/api/fs/file?path=x",
            previewable: true,
            missing: true,
          },
        } as unknown as Artifact}
      />,
    );
    expect(screen.getByTestId("artifact-missing-file")).toBeInTheDocument();
    expect(screen.getByText(/no longer exists/)).toBeInTheDocument();
    expect(screen.getByText("/Users/me/MOZI/output/report.pdf")).toBeInTheDocument();
  });

  it("classifies HTTP 404 fetch failures as missing-file, other failures as not", () => {
    expect(isMissingFileError("HTTP 404")).toBe(true);
    expect(isMissingFileError("HTTP 500")).toBe(false);
    expect(isMissingFileError(null)).toBe(false);
  });
});

describe("SourcesRenderer (workbench source list)", () => {
  it("renders titled jump links with snippets and filters non-web urls", () => {
    renderWithLocale(
      <SourcesRenderer
        artifact={artifact({
          plugin_id: "sources_v1",
          data: {
            sources: [
              { title: "CPI Summary", url: "https://bls.gov/cpi", snippet: "Rose 3.5 percent", hostname: "bls.gov" },
              { title: "Evil", url: "javascript:alert(1)" },
              { url: "https://bea.gov/pce", hostname: "bea.gov" },
            ],
          },
        })}
      />,
    );
    const links = screen.getAllByTestId("sources-renderer-link");
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent("CPI Summary");
    expect(links[0]).toHaveTextContent("Rose 3.5 percent");
    expect(links[0]).toHaveAttribute("href", "https://bls.gov/cpi");
    expect(links[1]).toHaveTextContent("bea.gov");
  });
});

describe("CodeRenderer — disk is the render truth (root-cause decision 2026-07-19)", () => {
  // Real incident: an 18KB template with `const DATA = /* DATA_JSON_PLACEHOLDER */;`
  // was carded, then 113KB of processed data was injected into the PERSISTED
  // file via shell. Every gate verified the disk file; the workbench rendered
  // the stale snapshot — five empty charts under a green plan.
  const SNAPSHOT = "<!DOCTYPE html><html><body><script>const DATA = /* DATA_JSON_PLACEHOLDER */;</script></body></html>";
  const DISK = "<!DOCTYPE html><html><body><h1>Injected Dashboard</h1><script>const DATA = {\"countries\":[\"China\"]};</script></body></html>";

  it("renders the persisted file content when the completed artifact carries persisted_path", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/fs/file?")) {
        return Promise.resolve({ ok: true, text: () => Promise.resolve(DISK) } as Response);
      }
      return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") } as Response);
    }));
    try {
      const { container } = renderWithLocale(
        <CodeRenderer
          artifact={artifact({
            data: { content_type: "html", code: SNAPSHOT, persisted_path: "/tmp/artifacts/dash.html", version_number: 1 },
          })}
          showCode={false}
        />,
      );
      await waitFor(() => {
        expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Injected Dashboard");
      });
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).not.toContain("DATA_JSON_PLACEHOLDER");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("falls back to the snapshot when the persisted file is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve("") } as Response)));
    try {
      const { container } = renderWithLocale(
        <CodeRenderer
          artifact={artifact({
            data: { content_type: "html", code: "<!DOCTYPE html><html><body><h1>Snapshot</h1></body></html>", persisted_path: "/gone.html" },
          })}
          showCode={false}
        />,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("Snapshot");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not fetch for running artifacts or artifacts without a persisted file", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      renderWithLocale(
        <CodeRenderer
          artifact={artifact({ status: "running", data: { content_type: "html", code: "<p>x</p>", persisted_path: "/tmp/a.html", live_preview: true } })}
          showCode={false}
        />,
      );
      renderWithLocale(
        <CodeRenderer
          artifact={artifact({ data: { content_type: "html", code: "<!DOCTYPE html><html><body>y</body></html>" } })}
          showCode={false}
        />,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
