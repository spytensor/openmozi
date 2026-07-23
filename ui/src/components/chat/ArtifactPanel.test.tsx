import { act, fireEvent, screen, renderWithLocale, waitFor } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { Artifact } from "@/types";
import ArtifactPanel from "./ArtifactPanel";

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "artifact-1",
    plugin_id: "sandpack_v1",
    title: "Investment report",
    status: "completed",
    data: {
      content_type: "html",
      code: "<!DOCTYPE html><html><body><h1>Report</h1></body></html>",
    },
    timestamp: 1,
    ...overrides,
  };
}

function fileArtifact(data: Partial<Artifact["data"]> = {}): Artifact {
  return artifact({
    plugin_id: "file_v1",
    title: "Generated file",
    data: {
      path: "/tmp/summary.pdf",
      filename: "summary.pdf",
      ext: "pdf",
      size: 2048,
      mime: "application/pdf",
      kind: "document",
      previewable: true,
      previewUrl: "/api/fs/preview?path=%2Ftmp%2Fsummary.pdf",
      ...data,
    },
  });
}

// A file type with NO specialized renderer (pdf/office/docx/sheet/image/text
// all have their own since #440) — only these route to the QuickLook
// preview-image branch.
function quicklookArtifact(data: Partial<Artifact["data"]> = {}): Artifact {
  return artifact({
    plugin_id: "file_v1",
    title: "Generated file",
    data: {
      path: "/tmp/design.sketch",
      filename: "design.sketch",
      ext: "sketch",
      size: 2048,
      mime: "application/octet-stream",
      kind: "binary",
      previewable: true,
      previewUrl: "/api/fs/preview?path=%2Ftmp%2Fdesign.sketch",
      ...data,
    },
  });
}

function renderPanel(props: Partial<ComponentProps<typeof ArtifactPanel>> = {}) {
  return renderWithLocale(
    <ArtifactPanel
      artifact={artifact()}
      width={600}
      fullscreen={false}
      docked={true}
      onResize={vi.fn()}
      onFullscreenChange={vi.fn()}
      onClose={vi.fn()}
      {...props}
    />,
  );
}

describe("ArtifactPanel", () => {
  it("opens Office files with the signed ONLYOFFICE session and destroys the editor on close", async () => {
    const destroyEditor = vi.fn();
    const DocEditor = vi.fn(() => ({ destroyEditor }));
    window.DocsAPI = { DocEditor };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        available: true,
        mode: "native",
        engine: "onlyoffice",
        editable: false,
        scriptUrl: "http://localhost:8082/web-apps/apps/api/documents/api.js",
        config: { documentType: "word", token: "signed-config" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const view = renderPanel({
      artifact: fileArtifact({
        path: "/tmp/report.docx",
        filename: "report.docx",
        ext: "docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    });

    expect(screen.getByTestId("native-office-editor")).toBeInTheDocument();
    await waitFor(() => expect(DocEditor).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/office/session?path=%2Ftmp%2Freport.docx"),
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(DocEditor.mock.calls[0][1]).toMatchObject({
      documentType: "word",
      token: "signed-config",
      width: "100%",
      height: "100%",
    });

    view.unmount();
    expect(destroyEditor).toHaveBeenCalledTimes(1);
    fetchMock.mockRestore();
    delete window.DocsAPI;
  });

  it("opens spreadsheets in native Office instead of the simplified grid", async () => {
    const DocEditor = vi.fn(() => ({ destroyEditor: vi.fn() }));
    window.DocsAPI = { DocEditor };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        success: true,
        available: true,
        mode: "native",
        engine: "onlyoffice",
        editable: false,
        scriptUrl: "http://localhost:8082/web-apps/apps/api/documents/api.js",
        config: { documentType: "cell", token: "signed-sheet-config" },
      }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    renderPanel({
      artifact: fileArtifact({
        path: "/data/output/budget.xlsx",
        filename: "budget.xlsx",
        ext: "xlsx",
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    });

    expect(screen.getByTestId("native-office-editor")).toBeInTheDocument();
    await waitFor(() => expect(DocEditor).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/office/session?path=%2Fdata%2Foutput%2Fbudget.xlsx"),
      expect.objectContaining({ credentials: "same-origin" }),
    );

    fetchMock.mockRestore();
    delete window.DocsAPI;
  });

  it("lets the user drag the left edge to resize the artifact workspace", () => {
    const onResize = vi.fn();
    renderPanel({ width: 600, onResize });

    act(() => {
      screen.getByTestId("artifact-resize-handle").dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, clientX: 700 }),
      );
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 520 }));
    });

    expect(onResize).toHaveBeenCalledWith(780);
  });

  it("offers the fullscreen toggle for FILE artifacts too (PDF previews need it most)", () => {
    const onFullscreenChange = vi.fn();
    renderPanel({
      artifact: fileArtifact({ filename: "report.pdf", content_type: "application/pdf" }),
      onFullscreenChange,
    });

    const toggle = screen.getByTestId("artifact-fullscreen-toggle");
    fireEvent.click(toggle);
    expect(onFullscreenChange).toHaveBeenCalledWith(true);
  });

  it("hides the resize handle when the artifact is fullscreen", () => {
    renderPanel({ fullscreen: true });

    expect(screen.queryByTestId("artifact-resize-handle")).not.toBeInTheDocument();
    expect(screen.getByTestId("artifact-panel")).toHaveClass("z-[100]");
  });

  it("uses Escape to exit fullscreen before closing the panel", () => {
    const onFullscreenChange = vi.fn();
    const onClose = vi.fn();
    renderPanel({ fullscreen: true, onFullscreenChange, onClose });

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onFullscreenChange).toHaveBeenCalledWith(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows a live status strip while the artifact is still being written", () => {
    renderPanel({
      artifact: artifact({
        status: "running",
        fallback_text: "Writing document...",
        data: { content_type: "markdown", phase: "writing", live_preview: true },
      }),
    });

    expect(screen.getByTestId("artifact-live-status")).toHaveTextContent("Writing document...");
    expect(screen.getByTestId("artifact-live-status")).toHaveTextContent("Live");
  });

  it("downloads a completed artifact in its native format", () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    renderPanel();
    fireEvent.click(screen.getByTestId("artifact-download"));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/html");
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("does not offer download while the artifact is still being written", () => {
    renderPanel({
      artifact: artifact({ status: "running", data: { content_type: "html", code: "" } }),
    });
    expect(screen.queryByTestId("artifact-download")).not.toBeInTheDocument();
  });

  const docArtifact = () =>
    artifact({
      title: "Research report",
      plugin_id: "document_v1",
      data: { content_type: "markdown", markdown: "# Title\n\nBody text." },
    });

  it("offers PDF and Markdown for a document artifact", () => {
    renderPanel({ artifact: docArtifact() });
    fireEvent.click(screen.getByTestId("artifact-download"));

    expect(screen.getByTestId("artifact-download-pdf")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-download-md")).toBeInTheDocument();
  });

  it("exports a document as PDF via a hidden print iframe (no blank popup)", () => {
    renderPanel({ artifact: docArtifact() });
    fireEvent.click(screen.getByTestId("artifact-download"));
    fireEvent.click(screen.getByTestId("artifact-download-pdf"));

    const frame = document.querySelector('[data-testid="artifact-print-frame"]') as HTMLIFrameElement | null;
    expect(frame).not.toBeNull();
    // The print surface carries the rendered markdown, not raw source.
    const srcdoc = frame!.getAttribute("srcdoc") ?? "";
    expect(srcdoc).toContain('<h1 id="title" tabindex="-1">Title</h1>');
    expect(srcdoc).toContain("Body text.");

    frame!.remove();
  });

  it("downloads the markdown source from the document menu", () => {
    const createObjectURL = vi.fn(() => "blob:mock");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    renderPanel({ artifact: docArtifact() });
    fireEvent.click(screen.getByTestId("artifact-download"));
    fireEvent.click(screen.getByTestId("artifact-download-md"));

    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("text/markdown");
    expect(clickSpy).toHaveBeenCalledTimes(1);

    clickSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("routes non-specialized file_v1 artifacts to a preview image inside the panel", () => {
    renderPanel({ artifact: quicklookArtifact() });

    expect(screen.getByTestId("artifact-panel")).toHaveAttribute("data-artifact-kind", "file");
    expect(screen.getByTestId("file-artifact-preview-image")).toHaveAttribute(
      "src",
      "/api/fs/preview?path=%2Ftmp%2Fdesign.sketch",
    );
    expect(screen.getAllByText("design.sketch").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByTestId("artifact-download")).toBeInTheDocument();
    // Operator decision 2026-07-18: file artifacts keep the fullscreen toggle
    // (PDF previews need it most) — the old file-kind exclusion is gone.
    expect(screen.getByTestId("artifact-fullscreen-toggle")).toBeInTheDocument();
  });

  it("renders a file card with Download and no preview image when file_v1 is not previewable", () => {
    renderPanel({
      artifact: quicklookArtifact({
        previewable: false,
        previewUrl: undefined,
      }),
    });

    expect(screen.queryByTestId("file-artifact-preview-image")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-artifact-card")).toHaveTextContent("design.sketch");
    expect(screen.getByTestId("file-artifact-download")).toHaveAttribute(
      "href",
      "/api/fs/file?path=%2Ftmp%2Fdesign.sketch",
    );
  });

  it("falls back to the file card when the file_v1 preview image fails to load", () => {
    renderPanel({ artifact: quicklookArtifact() });

    fireEvent.error(screen.getByTestId("file-artifact-preview-image"));

    expect(screen.queryByTestId("file-artifact-preview-image")).not.toBeInTheDocument();
    expect(screen.getByTestId("file-artifact-card")).toHaveTextContent("design.sketch");
    expect(screen.getByTestId("file-artifact-download")).toBeInTheDocument();
  });

  // Locks the #440 priority: specialized renderers beat the QuickLook
  // preview image even when a previewUrl exists. A branch reorder that puts
  // the preview image first (rejected in #463 review) must fail here.
  it("routes a PDF to its specialized renderer, never the QuickLook preview image", () => {
    renderPanel({ artifact: fileArtifact() });

    expect(screen.getByTestId("artifact-panel")).toHaveAttribute("data-artifact-kind", "file");
    expect(screen.queryByTestId("file-artifact-preview-image")).not.toBeInTheDocument();
    expect(screen.queryByTestId("file-artifact-card")).not.toBeInTheDocument();
  });
});
