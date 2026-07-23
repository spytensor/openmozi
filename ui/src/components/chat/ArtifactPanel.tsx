import { useCallback, useEffect, useRef, useState } from "react";
import { X, Code2, Download, FileText, Maximize2, Minimize2, GripVertical } from "lucide-react";
import type { Artifact } from "@/types";
import { cn } from "@/lib/utils";
import { useLocale, type MessageKey } from "@/i18n";
import {
  resolveArtifactKind,
  getArtifactDownload,
  isDocumentArtifact,
  renderArtifactPrintHtml,
  CodeRenderer,
  DocumentRenderer,
  ArtifactsIndexRenderer,
  FileArtifactRenderer,
  ImageRenderer,
  SourcesRenderer,
  EmptyState,
  getFileArtifactInfo,
} from "./artifact-renderers";
import ArtifactErrorBoundary from "./ArtifactErrorBoundary";
import { TypeIcon, resolveArtifactType } from "./artifact-type-icons";
import DeliverableVersionHistory from "@/components/files/DeliverableVersionHistory";

interface ArtifactPanelProps {
  artifact: Artifact;
  width?: number;
  fullscreen: boolean;
  docked: boolean;
  /**
   * Returns the width actually applied (after the owner's clamp) so the drag
   * accumulator can re-anchor at the boundary instead of building phantom
   * delta past it. A void return is treated as "applied as requested".
   */
  onResize: (width: number) => number | void;
  onResizeStart?: () => void;
  onResizeEnd?: () => void;
  onFullscreenChange: (fullscreen: boolean) => void;
  onClose: () => void;
  /** Open another artifact in this panel (artifacts-index entries). */
  onOpenArtifact?: (artifact: Artifact) => void;
  /** Navigate to a continuation session created from a registered deliverable. */
  onOpenSession?: (sessionId: string) => void;
}

/**
 * The artifact canvas — the shell around a content renderer.
 *
 * It owns the chrome (title, type badge, fullscreen, close) and dispatches the
 * body to a renderer chosen by {@link resolveArtifactKind}. New content kinds
 * plug in via `artifact-renderers` without touching this shell.
 */
export default function ArtifactPanel({
  artifact,
  width,
  fullscreen,
  docked,
  onResize,
  onResizeStart,
  onResizeEnd,
  onFullscreenChange,
  onClose,
  onOpenArtifact,
  onOpenSession,
}: ArtifactPanelProps) {
  const { t } = useLocale();
  const [showCode, setShowCode] = useState(false);
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const resizeHandleRef = useRef<HTMLButtonElement | null>(null);
  // Read through a ref inside drag callbacks so the pointerdown listener isn't
  // torn down and re-added on every width change (i.e. every drag frame).
  const widthRef = useRef(width);
  widthRef.current = width;

  const kind = resolveArtifactKind(artifact);
  const fileInfo = kind === "file" ? getFileArtifactInfo(artifact) : null;
  const type = resolveArtifactType(artifact);
  const typeLabel = t(`artifact.type.${type}` as MessageKey);
  const panelTitle = fileInfo?.filename ?? artifact.title;
  const canResize = docked && !fullscreen && typeof width === "number";
  const isRunning = artifact.status === "running";
  const liveLabel = artifact.fallback_text || t("artifact.live.preparing");
  const download = isRunning ? null : getArtifactDownload(artifact);
  const canExportPdf = !isRunning && isDocumentArtifact(artifact);
  const [downloadMenuOpen, setDownloadMenuOpen] = useState(false);
  const [fileRevision, setFileRevision] = useState(0);
  const deliverableId = kind === "file" && typeof artifact.data.deliverableId === "string"
    ? artifact.data.deliverableId
    : null;

  useEffect(() => { setFileRevision(0); }, [artifact.id]);

  const saveNative = useCallback(async () => {
    if (!download) return;
    let filename = download.filename;
    let objectUrl: string | null = null;
    if (download.url && download.direct) {
      const a = document.createElement("a");
      a.href = download.url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      return;
    }
    if (download.url) {
      // The `download` attribute is ignored for cross-origin URLs (the browser
      // navigates instead of saving), so fetch to a same-origin blob and take
      // the real extension from the blob's mime type.
      try {
        const blob = await (await fetch(download.url)).blob();
        objectUrl = URL.createObjectURL(blob);
        const ext = blob.type.split("/")[1]?.split("+")[0];
        if (ext && !/\.[a-z0-9]{2,5}$/i.test(filename)) filename = `${filename}.${ext}`;
      } catch (err) {
        console.warn("[artifact] image fetch failed, opening source directly", err);
        window.open(download.url, "_blank", "noopener");
        return;
      }
    } else {
      objectUrl = URL.createObjectURL(new Blob([download.text ?? ""], { type: download.mime ?? "text/plain" }));
    }
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Capture the revoke fn now — the timer may fire after the global is swapped.
    const revoke = URL.revokeObjectURL?.bind(URL);
    if (revoke) setTimeout(() => revoke(objectUrl!), 0);
  }, [download]);

  const exportPdf = useCallback(() => {
    const html = renderArtifactPrintHtml(artifact);
    if (!html) return;
    // Print-to-PDF from a hidden same-origin iframe: vector text, zero dependency,
    // and — unlike window.open — never a blank popup or a pop-up-blocker miss.
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-testid", "artifact-print-frame");
    iframe.setAttribute("aria-hidden", "true");
    iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
    iframe.srcdoc = html;
    iframe.onload = () => {
      const win = iframe.contentWindow;
      try {
        win?.focus();
        win?.print?.();
      } catch {
        /* printing unavailable in this environment */
      }
      setTimeout(() => iframe.remove(), 1000);
    };
    document.body.appendChild(iframe);
  }, [artifact]);

  const stopResize = useCallback(() => {
    const wasDragging = Boolean(dragRef.current);
    dragRef.current = null;
    setResizing(false);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    if (wasDragging) onResizeEnd?.();
  }, [onResizeEnd]);

  const onResizeMove = useCallback((event: PointerEvent) => {
    if (!dragRef.current) return;
    const delta = dragRef.current.startX - event.clientX;
    const desired = dragRef.current.startWidth + delta;
    const applied = onResize(desired);
    // When the owner clamps the width, re-anchor at the pointer so reversing
    // direction responds immediately instead of unwinding phantom delta first.
    if (typeof applied === "number" && applied !== desired) {
      dragRef.current = { startX: event.clientX, startWidth: applied };
    }
  }, [onResize]);

  const beginResize = useCallback((clientX: number) => {
    if (!canResize) return;
    dragRef.current = { startX: clientX, startWidth: widthRef.current ?? 0 };
    setResizing(true);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    onResizeStart?.();
  }, [canResize, onResizeStart]);

  useEffect(() => {
    const handle = resizeHandleRef.current;
    if (!handle || !canResize) return;
    const onNativePointerDown = (event: PointerEvent) => {
      event.preventDefault();
      beginResize(event.clientX);
    };
    handle.addEventListener("pointerdown", onNativePointerDown);
    return () => handle.removeEventListener("pointerdown", onNativePointerDown);
  }, [beginResize, canResize]);

  useEffect(() => {
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", onResizeMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
      stopResize();
    };
  }, [onResizeMove, stopResize]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (fullscreen) {
        onFullscreenChange(false);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, onClose, onFullscreenChange]);

  return (
    <div
      data-testid="artifact-panel"
      data-artifact-kind={kind}
      className={cn(
        "artifact-panel",
        "fixed inset-y-0 right-0 z-40 flex flex-col overflow-hidden bg-base border-l border-ink/[0.06]",
        resizing ? "" : "transition-[inset,width] duration-200",
        fullscreen ? "inset-0 z-[100]" : docked ? "" : "left-0 w-full",
      )}
      style={!fullscreen && docked && width ? { width } : undefined}
    >
      {canResize && (
        <button
          type="button"
          ref={resizeHandleRef}
          data-testid="artifact-resize-handle"
          aria-label={t("artifact.resizePanel")}
          title={t("artifact.resizePanelHint")}
          onDoubleClick={() => onResize(window.innerWidth * 0.5)}
          className="group absolute inset-y-0 left-0 z-10 flex w-3 -translate-x-1/2 cursor-col-resize items-center justify-center"
        >
          <span className="h-full w-px bg-ink/[0.08] transition-colors group-hover:bg-focus/60" />
          <span className="absolute flex h-9 w-4 items-center justify-center rounded-full border border-ink/[0.08] bg-surface/95 text-ink/25 shadow-lg opacity-0 transition-opacity group-hover:opacity-100">
            <GripVertical size={12} />
          </span>
        </button>
      )}

      {/* Header */}
      <div className="artifact-panel-header desktop-window-drag-region flex items-center gap-2 px-4 py-2.5 border-b border-ink/[0.06] bg-surface/95 backdrop-blur-sm shrink-0">
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-ink/[0.04] px-1.5 py-1 text-[11px] font-medium text-ink/48">
          <TypeIcon type={type} size={20} />
          <span>{typeLabel}</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink/80">{panelTitle}</span>
        {isRunning && (
          <div data-testid="artifact-live-status" className="ml-auto flex min-w-0 max-w-[42%] items-center gap-2 text-[11.5px] text-ink/42">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-activity pulse-dot" />
            <span className="min-w-0 truncate">{liveLabel}</span>
            <span className="shrink-0 rounded bg-activity/10 px-1.5 py-0.5 text-[10px] text-activity/70">
              {t("artifact.live.status")}
            </span>
          </div>
        )}

        <div className="flex items-center gap-1 ml-2">
          {kind === "code" && (
            <button
              onClick={() => setShowCode(!showCode)}
              className={cn("p-1.5 rounded-md transition-colors", showCode ? "text-selection bg-selection/10" : "text-ink/30 hover:text-ink/50")}
              aria-label={showCode ? t("artifact.hideCode") : t("artifact.showCode")}
              title={showCode ? t("artifact.hideCode") : t("artifact.showCode")}
            >
              <Code2 size={14} />
            </button>
          )}
          {download && !canExportPdf && (
            <button
              onClick={saveNative}
              data-testid="artifact-download"
              className="p-1.5 rounded-md text-ink/30 hover:text-ink/50 transition-colors"
              aria-label={t("artifact.download")}
              title={t("artifact.download")}
            >
              <Download size={14} />
            </button>
          )}
          {canExportPdf && (
            <div className="relative">
              <button
                onClick={() => setDownloadMenuOpen((v) => !v)}
                data-testid="artifact-download"
                aria-haspopup="menu"
                aria-expanded={downloadMenuOpen}
                className="p-1.5 rounded-md text-ink/30 hover:text-ink/50 transition-colors"
                aria-label={t("artifact.download")}
                title={t("artifact.download")}
              >
                <Download size={14} />
              </button>
              {downloadMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setDownloadMenuOpen(false)} />
                  <div
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-40 overflow-hidden rounded-lg border border-ink/10 bg-surface-elevated py-1 shadow-lg"
                    style={{ background: "var(--surface-elevated)" }}
                  >
                    <button
                      role="menuitem"
                      data-testid="artifact-download-pdf"
                      onClick={() => { setDownloadMenuOpen(false); exportPdf(); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink/70 hover:bg-ink/[0.06]"
                    >
                      <FileText size={13} className="text-ink/40" /> {t("artifact.download.pdf")}
                    </button>
                    <button
                      role="menuitem"
                      data-testid="artifact-download-md"
                      onClick={() => { setDownloadMenuOpen(false); saveNative(); }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink/70 hover:bg-ink/[0.06]"
                    >
                      <Download size={13} className="text-ink/40" /> {t("artifact.download.md")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* Every artifact kind gets fullscreen — file previews (PDF, sheets)
              need it most, and hiding it forced users to abuse the resize
              drag as a takeover (operator report 2026-07-18). */}
          <button
            onClick={() => onFullscreenChange(!fullscreen)}
            data-testid="artifact-fullscreen-toggle"
            className="p-1.5 rounded-md text-ink/30 hover:text-ink/50 transition-colors"
            aria-label={fullscreen ? t("artifact.exitFullscreen") : t("artifact.fullscreen")}
            title={fullscreen ? t("artifact.exitFullscreen") : t("artifact.fullscreen")}
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-ink/30 hover:text-ink/50 transition-colors"
            aria-label={t("artifact.closePanel")}
            title={t("artifact.close")}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Content — explicit height so renderers (Sandpack) can fill the space */}
      <div data-testid="artifact-panel-content" className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-hidden">
          <ArtifactErrorBoundary resetKey={`${artifact.id}:${fileRevision}`}>
            {kind === "file" ? (
              <FileArtifactRenderer key={fileRevision} artifact={artifact} />
            ) : kind === "document" ? (
              <DocumentRenderer artifact={artifact} />
            ) : kind === "image" ? (
              <ImageRenderer artifact={artifact} />
            ) : kind === "code" ? (
              <CodeRenderer artifact={artifact} showCode={showCode} />
            ) : kind === "sources" ? (
              <SourcesRenderer artifact={artifact} />
            ) : kind === "artifacts" ? (
              <ArtifactsIndexRenderer artifact={artifact} onOpen={onOpenArtifact} />
            ) : (
              <EmptyState label={t("artifact.unsupportedType")} />
            )}
          </ArtifactErrorBoundary>
        </div>
        {deliverableId && (
          <DeliverableVersionHistory
            deliverableId={deliverableId}
            onRollback={() => setFileRevision((current) => current + 1)}
            onOpenSession={onOpenSession}
          />
        )}
      </div>
    </div>
  );
}
