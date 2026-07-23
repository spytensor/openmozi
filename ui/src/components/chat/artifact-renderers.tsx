import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  SandpackProvider,
  SandpackPreview,
  SandpackCodeEditor,
  SandpackLayout,
} from "@codesandbox/sandpack-react";
import type { SandpackPredefinedTemplate, SandpackFiles, SandpackTheme } from "@codesandbox/sandpack-react";
import { renderAsync } from "docx-preview";
// pdfjs LEGACY build: the modern build assumes bleeding-edge JS APIs
// (Math.sumPrecise, Map.prototype.getOrInsertComputed, …) that Electron's
// Chromium lacks — every embedded font then fails to translate and pdfjs
// silently paints raw subset charcodes (garbled CJK/Latin). The legacy build
// ships its own shims, so no hand-rolled polyfills to forget next upgrade.
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorkerUrl from "@/lib/pdf-worker?worker&url";
import * as XLSX from "xlsx";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, Download, ExternalLink, FileX, Loader2 } from "lucide-react";
import type { Artifact } from "@/types";
import { useLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { TypeIcon, resolveArtifactType } from "./artifact-type-icons";
import MarkdownReadingSurface, {
  READING_MARKDOWN_COMPONENTS,
  rehypeMarkdownHeadingIds,
} from "./MarkdownReadingSurface";
import { normalizeMarkdownTables } from "./markdown-normalize";
import {
  fileDownloadUrl,
  buildFileArtifact,
  extractArtifactCode,
  formatFileSize,
  getFileArtifactInfo,
  isFileArtifact,
  resolveArtifactKind,
  artifactContentLooksLikeStandaloneHtml,
  type ArtifactKind,
  type FileArtifactInfo,
} from "@/lib/file-artifact";
import { highlightCode, shikiLangForExt } from "@/lib/shiki-highlight";
import { useTheme } from "@/theme/ThemeProvider";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Artifact canvas renderers.
 *
 * The canvas is a registry: an artifact's `plugin_id` / `content_type` maps to a
 * renderer. Adding a new content kind (pdf, sheet, slides, …) means adding a
 * renderer here and a case in {@link resolveArtifactKind} — the panel shell does
 * not change. Keep binary formats (Office/PDF/image-by-bytes) behind a backend
 * that exposes a fetchable URL on `artifact.data`.
 */
type ContentType = "html" | "react" | "svg" | "vanilla-js";

const LIVE_CODE_TAIL_LINES = 48;
const LIVE_CODE_TAIL_CHARS = 6000;

// ---------------------------------------------------------------------------
// Kind resolution
// ---------------------------------------------------------------------------

export function artifactTypeLabel(artifact: Artifact): string {
  switch (resolveArtifactKind(artifact)) {
    case "file":
      return "File";
    case "document":
      return "Doc";
    case "image":
      return "Image";
    case "code": {
      if (artifactContentLooksLikeStandaloneHtml(artifact)) return "HTML";
      const ct = String(artifact.data.content_type ?? "").toLowerCase();
      if (ct === "react") return "React";
      if (ct === "svg") return "SVG";
      if (ct === "html") return "HTML";
      if (ct === "javascript" || ct === "vanilla-js") return "JS";
      return "Code";
    }
    default:
      return "File";
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringMatrixValue(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows = value
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) => row.map((cell) => String(cell ?? "")));
  return rows.length > 0 ? rows : null;
}

function basename(path: string): string | null {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? null;
}

function inferExtension(filename: string): string {
  const last = filename.split(".").pop();
  return last && last !== filename ? last.replace(/^\./, "").toLowerCase() : "";
}

// Re-exported from the lightweight module so existing importers keep working
// without pulling heavy renderer deps into their bundle.
export { fileDownloadUrl, buildFileArtifact, formatFileSize, getFileArtifactInfo, resolveArtifactKind };
export type { ArtifactKind, FileArtifactInfo };

export function officePdfUrl(path: string): string {
  return `/api/fs/office-pdf?path=${encodeURIComponent(path)}`;
}

/** One-line content preview for the inline card (Manus-style thumbnail text). */
export function artifactSnippet(artifact: Artifact): string {
  const kind = resolveArtifactKind(artifact);
  if (kind === "document") {
    const md = extractDocument(artifact);
    const firstProse = md
      .split("\n")
      .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^\s*[-*|]\s*/, "").trim())
      .find((line) => line.length > 0);
    return firstProse ? firstProse.slice(0, 120) : "";
  }
  if (kind === "code") {
    const code = extractCode(artifact) ?? "";
    const explicit = String(artifact.data.content_type ?? "").toLowerCase();
    const contentType = explicit === "javascript" ? "vanilla-js" : explicit || detectContentType(code);
    if (contentType === "html" || contentType === "svg") {
      const visibleText = extractVisibleMarkupText(code);
      if (visibleText) return visibleText.slice(0, 120);
    }
    return code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !/^<!doctype\b/i.test(line) && !/^<\/?(html|head|body)\b/i.test(line))
      .find((line) => line.length > 0)
      ?.slice(0, 120) ?? "";
  }
  return "";
}

function decodeCommonEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function extractVisibleMarkupText(markup: string): string {
  return decodeCommonEntities(markup)
    .replace(/<!doctype[^>]*>/gi, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<head\b[\s\S]*?<\/head>/gi, " ")
    .replace(/<svg\b[^>]*>/gi, " ")
    .replace(/<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Document renderer (markdown / report)
// ---------------------------------------------------------------------------

// Documents consume the SAME reading-surface spec as chat (./prose). The old
// local PROSE_CLASS leaned on `prose prose-invert` — Tailwind Typography was
// never registered, so documents shipped as walls of 14px preflight-reset
// text (operator report 2026-07-19: "reads like a terminal").

function extractDocument(artifact: Artifact): string {
  const d = artifact.data;
  for (const key of ["markdown", "content", "text", "code"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  return "";
}

export function DocumentRenderer({ artifact }: { artifact: Artifact }) {
  const markdown = useMemo(() => extractDocument(artifact), [artifact.data]);
  if (!markdown) {
    return artifact.status === "running"
      ? <LiveWorkingState artifact={artifact} />
      : <EmptyState label="No document content" />;
  }
  return (
    <div className="h-full overflow-y-auto p-4">
      <MarkdownReadingSurface
        className="mx-auto w-full max-w-[960px]"
        markdown={markdown}
        testId="artifact-markdown-document"
        variant="document"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image renderer
// ---------------------------------------------------------------------------

function extractImageSrc(artifact: Artifact): string | null {
  const d = artifact.data;
  for (const key of ["image_url", "url", "src", "image"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  return null;
}

export function ImageRenderer({ artifact }: { artifact: Artifact }) {
  const src = useMemo(() => extractImageSrc(artifact), [artifact.data]);
  if (!src) return <EmptyState label="No image to display" />;
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-black/20 p-6">
      <img src={src} alt={artifact.title} className="max-h-full max-w-full rounded-lg object-contain" />
    </div>
  );
}

type PdfDocumentProxy = import("pdfjs-dist/legacy/build/pdf.mjs").PDFDocumentProxy;
type SortDirection = "asc" | "desc";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "ods", "csv", "tsv"]);
// Formats supported by the local ONLYOFFICE session contract. The simplified
// PDF, HTML, and sheet renderers remain explicit fallbacks only.
const NATIVE_OFFICE_EXTENSIONS = new Set(["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "csv", "ppt", "pptx", "odp"]);
const MAX_RENDERED_SHEET_ROWS = 500;

function isPdfInfo(info: FileArtifactInfo): boolean {
  return info.ext === "pdf" || info.mime.toLowerCase().includes("application/pdf");
}

function isDocxInfo(info: FileArtifactInfo): boolean {
  return info.ext === "docx" || info.mime.toLowerCase().includes(DOCX_MIME);
}

function isSheetInfo(info: FileArtifactInfo): boolean {
  const mime = info.mime.toLowerCase();
  return SHEET_EXTENSIONS.has(info.ext)
    || mime.includes(XLSX_MIME)
    || mime.includes("text/csv")
    || mime.includes("text/tab-separated-values");
}

function isOfficeConvertInfo(info: FileArtifactInfo): boolean {
  return NATIVE_OFFICE_EXTENSIONS.has(info.ext);
}

function safeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useFileArrayBuffer(url: string | null) {
  const [buffer, setBuffer] = useState<ArrayBuffer | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setBuffer(null);
      setStatus("idle");
      setError(null);
      return;
    }

    const controller = new AbortController();
    setBuffer(null);
    setStatus("loading");
    setError(null);

    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then((nextBuffer) => {
        setBuffer(nextBuffer);
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setBuffer(null);
        setStatus("failed");
        setError(safeErrorMessage(err));
      });

    return () => controller.abort();
  }, [url]);

  return { buffer, status, error };
}

function FileArtifactFooter({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  return (
    <div className="shrink-0 border-t border-ink/[0.06] bg-surface/95 px-5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <TypeIcon type={type} size={28} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-ink/82">{info.filename}</p>
          {sizeLabel && <p className="mt-px text-[11px] text-ink/38">{sizeLabel}</p>}
        </div>
        {info.downloadUrl && (
          <a
            data-testid="file-artifact-download"
            href={info.downloadUrl}
            download={info.filename}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-action px-3 py-2 text-xs font-medium text-action-foreground shadow-sm transition-colors hover:bg-action-hover"
          >
            <Download size={14} />
            <span>{downloadLabel}</span>
          </a>
        )}
      </div>
    </div>
  );
}

function BinaryPreviewFrame({
  children,
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  children: React.ReactNode;
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-black/10">
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      <FileArtifactFooter info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />
    </div>
  );
}

const MAX_TEXT_PREVIEW_CHARS = 500_000;

function useFileText(url: string | null) {
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "failed">("idle");
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    if (!url) { setText(null); setStatus("idle"); setFetchError(null); return; }
    const controller = new AbortController();
    setText(null);
    setStatus("loading");
    setFetchError(null);
    fetch(url, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((body) => {
        setText(body.length > MAX_TEXT_PREVIEW_CHARS ? body.slice(0, MAX_TEXT_PREVIEW_CHARS) : body);
        setStatus("loaded");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setText(null);
        setStatus("failed");
        setFetchError(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [url]);

  return { text, status, fetchError };
}

/** Image files: render the bytes directly — no server-side preview needed. */
function ImageFileRenderer({
  info, type, sizeLabel, downloadLabel,
}: { info: FileArtifactInfo; type: string; sizeLabel: string; downloadLabel: string }) {
  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="flex h-full min-h-[260px] items-center justify-center overflow-auto p-6">
        <img
          data-testid="file-artifact-image"
          src={info.downloadUrl ?? undefined}
          alt={info.filename}
          className="max-h-full max-w-full rounded-lg border border-ink/[0.08] bg-white object-contain shadow-xl"
        />
      </div>
    </BinaryPreviewFrame>
  );
}

const MARKDOWN_PREVIEW_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/** Text/code/markdown/json/html source: fetch and render client-side. */
function TextFileRenderer({
  info, type, sizeLabel, downloadLabel,
}: { info: FileArtifactInfo; type: string; sizeLabel: string; downloadLabel: string }) {
  const { t } = useLocale();
  const { resolvedTheme } = useTheme();
  const { text, status, fetchError } = useFileText(info.downloadUrl);
  const asMarkdown = MARKDOWN_PREVIEW_EXTENSIONS.has(info.ext);
  const shikiLang = useMemo(() => shikiLangForExt(info.ext), [info.ext]);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    if (asMarkdown || status !== "loaded" || text === null) {
      setHighlightedHtml(null);
      return;
    }

    let cancelled = false;
    setHighlightedHtml(null);
    highlightCode(text, shikiLang, resolvedTheme === "dark")
      .then((html) => {
        if (cancelled) return;
        setHighlightedHtml(html);
      });

    return () => {
      cancelled = true;
    };
  }, [asMarkdown, resolvedTheme, shikiLang, status, text]);

  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div
        className={cn(
          "h-full min-h-0 overflow-auto bg-surface",
          asMarkdown ? "p-4" : "px-6 py-5",
        )}
        data-testid="file-artifact-text"
      >
        {status === "loading" && (
          <div className="flex items-center gap-2 text-xs text-ink/45"><Loader2 size={14} className="animate-spin text-activity" />{t("artifact.preview.loading")}</div>
        )}
        {/* A fetch failure is not a type problem — say what actually happened.
            A 404 means the file is GONE (legacy card predating the liveness
            flag, or cross-turn deletion) — honest missing state, not an error. */}
        {status === "failed" && (
          isMissingFileError(fetchError)
            ? <MissingFileNotice info={info} />
            : <div className="text-xs text-warning">{t("artifact.preview.loadFailed")}</div>
        )}
        {status === "loaded" && text !== null && (
          asMarkdown ? (
            <MarkdownReadingSurface
              className="mx-auto w-full max-w-[960px]"
              markdown={text}
              testId="file-markdown-document"
              variant="document"
            />
          ) : highlightedHtml ? (
            <div
              className="overflow-x-auto font-mono text-[12.5px]"
              dangerouslySetInnerHTML={{ __html: highlightedHtml }}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] leading-5 text-ink/80">{text}</pre>
          )
        )}
      </div>
    </BinaryPreviewFrame>
  );
}

/** Types that render as fetched text (source view). */
const TEXT_PREVIEW_TYPES = new Set(["code", "document", "html", "js", "react", "svg"]);

/** LibreOffice/PDF or format-specific preview used when ONLYOFFICE is unavailable. */
function OfficeFallbackRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { t } = useLocale();
  const [pdfFailed, setPdfFailed] = useState(false);
  const handleLoadFailed = useCallback(() => setPdfFailed(true), []);

  // Spreadsheets → interactive SheetJS grid (all worksheets).
  if (isSheetInfo(info)) {
    return <SheetFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Word → high-fidelity, scrollable, selectable client-side docx-preview. No
  // LibreOffice conversion, no ONLYOFFICE service — this is the primary Word
  // viewer now, not a last-resort fallback.
  if (isDocxInfo(info)) {
    return <DocxFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Slides / other office types → LibreOffice-converted PDF preview (the only
  // decent embedded option for pptx); binary card if even that is unavailable.
  if (pdfFailed) {
    return <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="office-fallback-preview">
      <div className="min-h-0 flex-1">
        <PdfFileRenderer
          info={info}
          type={type}
          sizeLabel={sizeLabel}
          downloadLabel={downloadLabel}
          pdfUrl={info.path ? officePdfUrl(info.path) : undefined}
          onLoadFailed={handleLoadFailed}
        />
      </div>
    </div>
  );
}

interface OnlyOfficeSessionResponse {
  success: boolean;
  available: boolean;
  mode: "native";
  engine: "onlyoffice";
  editable: boolean;
  scriptUrl: string;
  config: Record<string, unknown>;
}

interface OnlyOfficeEditorHandle { destroyEditor?: () => void }

declare global {
  interface Window {
    DocsAPI?: { DocEditor: new (elementId: string, config: Record<string, unknown>) => OnlyOfficeEditorHandle };
  }
}

const onlyOfficeScriptLoads = new Map<string, Promise<void>>();

function loadOnlyOfficeScript(url: string): Promise<void> {
  if (window.DocsAPI?.DocEditor) return Promise.resolve();
  const existing = onlyOfficeScriptLoads.get(url);
  if (existing) return existing;
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.async = true;
    script.dataset.onlyoffice = "true";
    script.onload = () => window.DocsAPI?.DocEditor ? resolve() : reject(new Error("ONLYOFFICE API did not initialize"));
    script.onerror = () => reject(new Error("ONLYOFFICE document service is unavailable"));
    document.head.appendChild(script);
  }).catch((error) => {
    onlyOfficeScriptLoads.delete(url);
    throw error;
  });
  onlyOfficeScriptLoads.set(url, promise);
  return promise;
}

function NativeOfficeRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { locale, t } = useLocale();
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(true);
  const editorId = useRef(`onlyoffice-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    if (!info.path) {
      setFallback(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let editor: OnlyOfficeEditorHandle | null = null;
    setFallback(false);
    setLoading(true);
    fetch(`/api/office/session?path=${encodeURIComponent(info.path)}&locale=${encodeURIComponent(locale)}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Native Office unavailable (${response.status})`);
        return response.json() as Promise<OnlyOfficeSessionResponse>;
      })
      .then(async (session) => {
        if (!session.available || !session.scriptUrl) throw new Error("Native Office unavailable");
        await loadOnlyOfficeScript(session.scriptUrl);
        if (controller.signal.aborted || !window.DocsAPI?.DocEditor) return;
        editor = new window.DocsAPI.DocEditor(editorId.current, {
          ...session.config,
          width: "100%",
          height: "100%",
        });
        setLoading(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFallback(true);
        setLoading(false);
      });
    return () => {
      controller.abort();
      editor?.destroyEditor?.();
    };
  }, [info.path, locale]);

  if (fallback) {
    return <OfficeFallbackRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface" data-testid="native-office-editor">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-ink/[0.06] px-3 text-[11px] text-ink/45">
        <span className="font-medium text-success">{t("artifact.office.native")}</span>
        <span>{t("artifact.office.readOnly")}</span>
      </div>
      <div className="relative min-h-0 flex-1">
        {loading && <div className="absolute inset-0 z-10 flex items-center justify-center"><LoadingState label={t("artifact.office.opening")} /></div>}
        <div id={editorId.current} className="h-full min-h-[420px] w-full" />
      </div>
    </div>
  );
}

function PdfFileRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
  pdfUrl,
  onLoadFailed,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
  pdfUrl?: string;
  /** Notified when the PDF source can't be fetched (e.g. office conversion
   *  failed server-side) so callers can fall back to a legacy renderer. */
  onLoadFailed?: () => void;
}) {
  const { buffer, status, error } = useFileArrayBuffer(pdfUrl ?? info.downloadUrl);
  useEffect(() => {
    if (status === "failed") onLoadFailed?.();
  }, [status, onLoadFailed]);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PdfDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageAspect, setPageAspect] = useState(Math.SQRT2);
  const [containerWidth, setContainerWidth] = useState(900);
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    if (!buffer) {
      setPdfDoc(null);
      setPageCount(0);
      setCurrentPage(1);
      return;
    }

    let cancelled = false;
    const task = pdfjsLib.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      // CJK CMaps + standard fonts (copied into dist by the pdfjsFontAssets Vite
      // plugin) so Chinese and other CID-font text renders instead of blanks.
      cMapUrl: `${import.meta.env.BASE_URL}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${import.meta.env.BASE_URL}standard_fonts/`,
    });
    task.promise
      .then(async (doc) => {
        // First page's aspect ratio sizes every unrendered placeholder so the
        // scrollbar length is honest before lazy rendering catches up.
        const first = await doc.getPage(1);
        const viewport = first.getViewport({ scale: 1 });
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPageAspect(viewport.height / viewport.width);
        setPdfDoc(doc);
        setPageCount(doc.numPages);
        setCurrentPage(1);
        setRenderError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPdfDoc(null);
        setPageCount(0);
        setRenderError(safeErrorMessage(err));
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [buffer]);

  // Pages render at the width they were mounted with — track the scroll
  // container so a panel drag re-renders them crisp at the new size.
  useEffect(() => {
    if (!scrollRoot) return;
    setContainerWidth(scrollRoot.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => setContainerWidth(scrollRoot.clientWidth), 150);
    });
    observer.observe(scrollRoot);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scrollRoot]);

  // The page indicator follows the scroll position: the current page is the
  // slot whose middle sits closest to the container's vertical center,
  // recomputed on scroll (rAF-throttled). Deterministic geometry — an
  // IntersectionObserver "center line" misses entirely when the line lands in
  // the 16px gap between pages or a fast scroll skips its ~1px band
  // (CDP-verified live 2026-07-18).
  useEffect(() => {
    if (!scrollRoot || pageCount === 0) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const rootRect = scrollRoot.getBoundingClientRect();
      const center = rootRect.top + rootRect.height / 2;
      let best = 1;
      let bestDistance = Number.POSITIVE_INFINITY;
      scrollRoot.querySelectorAll<HTMLElement>("[data-pdf-page]").forEach((slot) => {
        const rect = slot.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = Number(slot.dataset.pdfPage) || 1;
        }
      });
      setCurrentPage(best);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollRoot.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [scrollRoot, pageCount]);

  const displayError = error ?? renderError;
  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="relative flex h-full min-h-0 flex-col">
        {pageCount > 1 && (
          <div
            data-testid="pdf-page-indicator"
            className="pointer-events-none absolute right-4 top-3 z-20 rounded-full bg-surface/95 px-2.5 py-1 text-[11px] font-medium tabular-nums text-ink/55 shadow-md ring-1 ring-ink/[0.08]"
          >
            {currentPage} / {pageCount}
          </div>
        )}
        <div ref={setScrollRoot} className="relative min-h-0 flex-1 overflow-auto p-6">
          {status === "loading" && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/5">
              <LoadingState label="Loading preview" />
            </div>
          )}
          {(status === "failed" || displayError) && (
            isMissingFileError(displayError || error) ? (
              // The file is gone (deleted after delivery, or a stale card
              // from before the liveness flag existed) — say so honestly.
              <MissingFileNotice info={info} />
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <p className="max-w-[420px] text-sm text-ink/42">{displayError || "PDF preview failed"}</p>
              </div>
            )
          )}
          {pdfDoc && !displayError && (
            <div className="mx-auto flex w-fit flex-col items-center gap-4">
              {Array.from({ length: pageCount }, (_, index) => (
                <PdfPageView
                  key={index + 1}
                  pdfDoc={pdfDoc}
                  pageNumber={index + 1}
                  scrollRoot={scrollRoot}
                  containerWidth={containerWidth}
                  pageAspect={pageAspect}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </BinaryPreviewFrame>
  );
}

/** Width the page canvas targets inside the scroll container. */
function pdfTargetWidth(containerWidth: number): number {
  return Math.max(320, Math.min(containerWidth - 48, 1120));
}

/**
 * One page of the continuous-scroll PDF view. Renders lazily when scrolled
 * within 1200px of the viewport and RELEASES its bitmap again once scrolled
 * beyond that window (a 2× dpr page is ~28MB of backing store — a long report
 * scrolled end-to-end must not keep every page resident). The canvas CSS size
 * lives exclusively in React state: the render effect reports the measured
 * size instead of writing canvas.style directly, which React would silently
 * wipe on the next commit (retina displays then show the 2× bitmap raw).
 * Environments without IntersectionObserver render immediately.
 */
function PdfPageView({
  pdfDoc,
  pageNumber,
  scrollRoot,
  containerWidth,
  pageAspect,
}: {
  pdfDoc: PdfDocumentProxy;
  pageNumber: number;
  scrollRoot: HTMLDivElement | null;
  containerWidth: number;
  pageAspect: number;
}) {
  const holderRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(typeof IntersectionObserver === "undefined");
  const [rendered, setRendered] = useState(false);
  const [cssSize, setCssSize] = useState<{ w: number; h: number } | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setNearViewport(entry.isIntersecting);
      },
      { root: scrollRoot, rootMargin: "1200px 0px" },
    );
    observer.observe(holder);
    return () => observer.disconnect();
  }, [scrollRoot]);

  // Release the bitmap once far off-screen; cssSize is kept so the slot holds
  // its exact measured dimensions and the scroll position never jumps.
  useEffect(() => {
    if (nearViewport || !rendered) return;
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    setRendered(false);
  }, [nearViewport, rendered]);

  useEffect(() => {
    if (!nearViewport) return;
    let cancelled = false;
    let renderTask: pdfjsLib.RenderTask | null = null;
    pdfDoc
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled || !canvasRef.current) return null;
        const rawViewport = page.getViewport({ scale: 1 });
        const scale = Math.max(0.5, Math.min(2.5, pdfTargetWidth(containerWidth) / rawViewport.width));
        const viewport = page.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas context unavailable");
        const deviceScale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * deviceScale);
        canvas.height = Math.floor(viewport.height * deviceScale);
        setCssSize({ w: Math.floor(viewport.width), h: Math.floor(viewport.height) });
        context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);
        renderTask = page.render({ canvasContext: context, canvas, viewport });
        return renderTask.promise.then(() => true);
      })
      .then((didRender) => {
        if (cancelled || !didRender) return;
        setRendered(true);
        setPageError(null);
      })
      .catch((err: unknown) => {
        // Cancellation (scroll-away/resize mid-render) is routine; anything
        // else is a real per-page failure and must not leave a silent blank.
        if (cancelled) return;
        setPageError(safeErrorMessage(err));
      });
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [nearViewport, pdfDoc, pageNumber, containerWidth]);

  const placeholderWidth = pdfTargetWidth(containerWidth);
  return (
    <div ref={holderRef} data-pdf-page={pageNumber} className="relative min-w-0">
      <canvas
        ref={canvasRef}
        className="rounded-md bg-white shadow-xl ring-1 ring-ink/[0.08]"
        style={{
          width: cssSize?.w ?? placeholderWidth,
          height: cssSize?.h ?? Math.round(placeholderWidth * pageAspect),
        }}
      />
      {pageError && (
        <div
          data-testid="pdf-page-error"
          className="absolute inset-0 flex items-center justify-center px-6 text-center"
        >
          <p className="max-w-[320px] text-xs text-ink/42">{pageError}</p>
        </div>
      )}
    </div>
  );
}

const DOCX_ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const DOCX_ALLOWED_ATTRS = new Set(["alt", "colspan", "href", "rowspan", "src", "title"]);

function unwrapElement(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  while (element.firstChild) parent.insertBefore(element.firstChild, element);
  parent.removeChild(element);
}

function isSafeDocxUrl(value: string, allowImageData: boolean): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (allowImageData && /^data:image\//i.test(trimmed)) return true;
  if (trimmed.startsWith("#") || trimmed.startsWith("/") || trimmed.startsWith("./") || trimmed.startsWith("../")) return true;
  return /^(https?:|mailto:|tel:)/i.test(trimmed);
}


function DocxFileRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { buffer, status, error } = useFileArrayBuffer(info.downloadUrl);
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderStatus, setRenderStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [renderError, setRenderError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!buffer || !container) {
      setRenderStatus("idle");
      setRenderError(null);
      return;
    }

    let cancelled = false;
    container.replaceChildren();
    setRenderStatus("loading");
    setRenderError(null);

    // docx-preview renders the real Word layout (styles, tables, images,
    // headers/footers, page breaks) into the DOM — far higher fidelity than the
    // old mammoth HTML, fully client-side, no ONLYOFFICE service.
    renderAsync(buffer, container, undefined, {
      className: "docx",
      inWrapper: true,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      useBase64URL: true,
    })
      .then(() => { if (!cancelled) setRenderStatus("idle"); })
      .catch((err: unknown) => {
        if (cancelled) return;
        container.replaceChildren();
        setRenderStatus("failed");
        setRenderError(safeErrorMessage(err));
      });

    return () => { cancelled = true; };
  }, [buffer]);

  const failed = status === "failed" || renderStatus === "failed";
  const loading = status === "loading" || renderStatus === "loading";
  const displayError = error ?? renderError;

  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="h-full overflow-y-auto bg-neutral-200/60 px-4 py-5">
        {loading && <LoadingState label="Loading preview" />}
        {failed && (
          <div className="flex h-full items-center justify-center px-6 text-center">
            <p className="max-w-[420px] text-sm text-ink/42">{displayError || "DOCX preview failed"}</p>
          </div>
        )}
        <div
          ref={containerRef}
          data-testid="docx-preview-host"
          className="docx-preview-host mx-auto text-neutral-900"
          style={failed ? { display: "none" } : undefined}
        />
      </div>
    </BinaryPreviewFrame>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function normalizeSheetRows(rows: unknown[][]): string[][] {
  return rows
    .map((row) => row.map(cellText))
    .filter((row) => row.some((cell) => cell.trim().length > 0));
}

interface ParsedWorkbookSheet {
  name: string;
  rows: string[][];
}

function parseWorkbookSheets(buffer: ArrayBuffer, info: FileArtifactInfo): ParsedWorkbookSheet[] {
  const extension = info.ext.toLowerCase();
  // Honesty gate: a real .xlsx is a ZIP container (PK\x03\x04). SheetJS is
  // lenient and will "render" arbitrary text named .xlsx as a phantom
  // spreadsheet (seen live: a model wrote a 48-byte placeholder note with an
  // .xlsx name and the viewer showed a fake 0-row grid). Refuse loudly instead.
  if (extension === "xlsx") {
    const magic = new Uint8Array(buffer.slice(0, 4));
    const isZip = magic[0] === 0x50 && magic[1] === 0x4b && (magic[2] === 0x03 || magic[2] === 0x05 || magic[2] === 0x07);
    if (!isZip) {
      const textPeek = new TextDecoder("utf-8", { fatal: false }).decode(buffer.slice(0, 160)).trim();
      throw new Error(
        `Not a valid Excel file — the content is ${textPeek ? `plain text: "${textPeek}"` : "not an xlsx container"}. The file was likely written as a placeholder instead of a real workbook.`,
      );
    }
  }
  const workbook = extension === "csv" || extension === "tsv"
    ? XLSX.read(new TextDecoder().decode(buffer), {
      type: "string",
      raw: false,
      FS: extension === "tsv" ? "\t" : ",",
    })
    : XLSX.read(buffer, { type: "array", raw: false, cellDates: true });
  // Every sheet, not just the first — the old renderer silently dropped all
  // other worksheets, which is how a 5-sheet workbook read as a flat table.
  return workbook.SheetNames.map((name) => ({
    name,
    rows: normalizeSheetRows(
      XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: "", raw: false }) as unknown[][],
    ),
  }));
}

function compareSheetCells(a: string, b: string): number {
  const aNumber = Number(a.replace(/,/g, ""));
  const bNumber = Number(b.replace(/,/g, ""));
  if (a.trim() && b.trim() && Number.isFinite(aNumber) && Number.isFinite(bNumber)) return aNumber - bNumber;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function SheetFileRenderer({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  const { buffer, status, error } = useFileArrayBuffer(info.downloadUrl);
  const fallbackSheets: ParsedWorkbookSheet[] = info.previewRows?.length
    ? [{ name: "Sheet1", rows: info.previewRows }]
    : [];
  const [sheets, setSheets] = useState<ParsedWorkbookSheet[]>(fallbackSheets);
  const [activeSheet, setActiveSheet] = useState(0);
  const [viewMode, setViewMode] = useState<"grid" | "print">("grid");
  const [parseStatus, setParseStatus] = useState<"idle" | "loading" | "failed">("idle");
  const [parseError, setParseError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null);

  useEffect(() => {
    if (!buffer) {
      setSheets(info.previewRows?.length ? [{ name: "Sheet1", rows: info.previewRows }] : []);
      setParseStatus("idle");
      setParseError(null);
      return;
    }

    try {
      setParseStatus("loading");
      setParseError(null);
      setSheets(parseWorkbookSheets(buffer, info));
      setActiveSheet(0);
      setParseStatus("idle");
    } catch (err: unknown) {
      setSheets(info.previewRows?.length ? [{ name: "Sheet1", rows: info.previewRows }] : []);
      setParseStatus("failed");
      setParseError(safeErrorMessage(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buffer, info]);

  const rows = sheets[Math.min(activeSheet, Math.max(0, sheets.length - 1))]?.rows ?? [];
  // Styled print view (LibreOffice -> PDF) is offered for real workbooks only.
  const printViewAvailable = !!info.path && (info.ext === "xlsx" || info.ext === "xls");

  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  const headers = rows[0] ?? [];
  const bodyRows = rows.slice(1);
  const sortedRows = useMemo(() => {
    if (!sort) return bodyRows;
    return [...bodyRows].sort((a, b) => {
      const result = compareSheetCells(a[sort.column] ?? "", b[sort.column] ?? "");
      return sort.direction === "asc" ? result : -result;
    });
  }, [bodyRows, sort]);
  const visibleRows = sortedRows.slice(0, MAX_RENDERED_SHEET_ROWS);
  const rowCountLabel = `${bodyRows.length.toLocaleString()} rows`;
  const failed = status === "failed" || parseStatus === "failed";
  const loading = status === "loading" || parseStatus === "loading";

  return (
    <BinaryPreviewFrame info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-ink/[0.06] bg-surface/90 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <p className="shrink-0 truncate text-xs font-medium text-ink/62">{info.filename}</p>
            {sheets.length > 1 && viewMode === "grid" && (
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                {sheets.map((sheet, index) => (
                  <button
                    key={`${sheet.name}:${index}`}
                    type="button"
                    onClick={() => { setActiveSheet(index); setSort(null); }}
                    className={`shrink-0 rounded-md px-2 py-1 text-[11px] font-medium transition-colors ${
                      index === activeSheet
                        ? "bg-selection/15 text-selection"
                        : "text-ink/45 hover:bg-ink/[0.05] hover:text-ink/70"
                    }`}
                  >
                    {sheet.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {printViewAvailable && (
              <button
                type="button"
                onClick={() => setViewMode((mode) => (mode === "grid" ? "print" : "grid"))}
                className="rounded-md border border-ink/[0.08] px-2 py-1 text-[11px] font-medium text-ink/50 transition-colors hover:bg-ink/[0.05] hover:text-ink/75"
              >
                {viewMode === "grid" ? "Print view" : "Data view"}
              </button>
            )}
            {viewMode === "grid" && (
              <span className="rounded-md border border-ink/[0.08] bg-ink/[0.04] px-2 py-1 text-[11px] font-medium text-ink/50">
                {rowCountLabel}
              </span>
            )}
          </div>
        </div>
        {viewMode === "print" && info.path ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <PdfFileRenderer
              info={info}
              type={type}
              sizeLabel={sizeLabel}
              downloadLabel={downloadLabel}
              pdfUrl={officePdfUrl(info.path)}
              onLoadFailed={() => setViewMode("grid")}
            />
          </div>
        ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading && <LoadingState label="Loading preview" />}
          {failed && rows.length === 0 && (
            <div className="flex h-full items-center justify-center px-6 text-center">
              <p className="max-w-[420px] text-sm text-ink/42">{error ?? parseError ?? "Sheet preview failed"}</p>
            </div>
          )}
          {!loading && rows.length === 0 && !failed && <EmptyState label="No sheet data" />}
          {rows.length > 0 && (
            <table className="min-w-full border-separate border-spacing-0 rounded-md border border-ink/[0.08] bg-surface text-left text-xs shadow-sm">
              <thead className="sticky top-0 z-10 bg-surface">
                <tr>
                  {Array.from({ length: columnCount }).map((_, index) => {
                    const active = sort?.column === index;
                    const Icon = active ? (sort.direction === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
                    return (
                      <th key={index} className="border-b border-r border-ink/[0.08] px-0 py-0 last:border-r-0">
                        <button
                          type="button"
                          onClick={() => {
                            setSort((current) => current?.column === index
                              ? { column: index, direction: current.direction === "asc" ? "desc" : "asc" }
                              : { column: index, direction: "asc" });
                          }}
                          className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left font-medium text-ink/62 transition-colors hover:bg-ink/[0.04]"
                        >
                          <span className="max-w-[220px] truncate">{headers[index]?.trim() || `Column ${index + 1}`}</span>
                          <Icon size={13} className={active ? "text-selection" : "text-ink/30"} />
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, rowIndex) => (
                  <tr key={rowIndex} className="odd:bg-ink/[0.018]">
                    {Array.from({ length: columnCount }).map((_, cellIndex) => (
                      <td key={cellIndex} className="max-w-[280px] border-b border-r border-ink/[0.06] px-3 py-2 text-ink/68 last:border-r-0">
                        <span className="block truncate">{row[cellIndex] ?? ""}</span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}
      </div>
    </BinaryPreviewFrame>
  );
}

// ---------------------------------------------------------------------------
// File renderer (backend file_v1: binary previews, images, or download cards)
// ---------------------------------------------------------------------------

export function FileArtifactRenderer({ artifact }: { artifact: Artifact }) {
  const { locale, t } = useLocale();
  const info = useMemo(() => getFileArtifactInfo(artifact), [artifact]);
  const canPreview = Boolean(info?.previewable && info.previewUrl);
  const [previewState, setPreviewState] = useState<"loading" | "loaded" | "failed">(
    canPreview ? "loading" : "failed",
  );

  useEffect(() => {
    setPreviewState(canPreview ? "loading" : "failed");
  }, [canPreview, info?.previewUrl]);

  if (!info) return <EmptyState label={t("artifact.unsupportedType")} />;

  const type = resolveArtifactType(artifact);
  const sizeLabel = formatFileSize(info.size, locale);
  const downloadLabel = t("artifact.download");
  const previewUrl = info.previewUrl;

  // Deliverable liveness (operator decision 2026-07-19): a card whose file
  // vanished from disk states that honestly instead of routing to a preview
  // that can only 404.
  if (info.missing) {
    return <MissingFileNotice info={info} />;
  }

  if (info.downloadUrl && isPdfInfo(info)) {
    return <PdfFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Office documents use the local editor-grade viewer first, including
  // spreadsheets. Fallbacks remain format-specific and are labeled honestly.
  // Order matters: this must win over the docx/sheet branches.
  if (info.downloadUrl && info.path && isOfficeConvertInfo(info)) {
    return (
      <NativeOfficeRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />
    );
  }

  if (info.downloadUrl && isDocxInfo(info)) {
    return <DocxFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  if (info.downloadUrl && isSheetInfo(info)) {
    return <SheetFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Images render their own bytes directly (no macOS QuickLook previewUrl needed).
  if (info.downloadUrl && type === "image") {
    return <ImageFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  // Text/code/json/markdown/html: fetch and render the source client-side.
  if (info.downloadUrl && TEXT_PREVIEW_TYPES.has(type)) {
    return <TextFileRenderer info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />;
  }

  if (canPreview && previewUrl && previewState !== "failed") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-black/10">
        <div className="min-h-0 flex-1 overflow-auto p-6">
          <div className="relative flex h-full min-h-[260px] items-center justify-center">
            {previewState === "loading" && (
              <div
                data-testid="file-artifact-preview-loading"
                className="absolute inset-0 z-10 flex items-center justify-center"
              >
                <div className="flex items-center gap-2 rounded-lg border border-ink/[0.06] bg-surface/90 px-3 py-2 text-xs text-ink/45 shadow-sm backdrop-blur">
                  <Loader2 size={14} className="animate-spin text-activity" />
                  <span>{t("artifact.preview.loading")}</span>
                </div>
              </div>
            )}
            <img
              data-testid="file-artifact-preview-image"
              src={previewUrl}
              alt={info.filename}
              onLoad={() => setPreviewState("loaded")}
              onError={() => setPreviewState("failed")}
              className={cn(
                "max-h-full max-w-full rounded-lg border border-ink/[0.08] bg-white object-contain shadow-xl transition-opacity duration-150",
                previewState === "loading" ? "opacity-0" : "opacity-100",
              )}
            />
          </div>
        </div>
        <FileArtifactFooter info={info} type={type} sizeLabel={sizeLabel} downloadLabel={downloadLabel} />
      </div>
    );
  }

  return (
    <FileArtifactFallbackCard
      info={info}
      type={type}
      sizeLabel={sizeLabel}
      downloadLabel={downloadLabel}
    />
  );
}

function FileArtifactFallbackCard({
  info,
  type,
  sizeLabel,
  downloadLabel,
}: {
  info: FileArtifactInfo;
  type: string;
  sizeLabel: string;
  downloadLabel: string;
}) {
  return (
    <div className="flex h-full items-center justify-center overflow-auto p-6">
      <div
        data-testid="file-artifact-card"
        className="flex w-full max-w-[360px] flex-col items-center rounded-lg border border-ink/[0.08] bg-ink/[0.03] px-6 py-7 text-center shadow-sm"
      >
        <TypeIcon type={type} size={64} />
        <p className="mt-4 w-full truncate text-[15px] font-medium text-ink/86">{info.filename}</p>
        <div className="mt-2 flex max-w-full flex-wrap items-center justify-center gap-2 text-[11px] text-ink/40">
          {sizeLabel && <span>{sizeLabel}</span>}
          {info.ext && (
            <span className="rounded-md border border-ink/[0.08] bg-ink/[0.04] px-1.5 py-0.5 font-medium uppercase tracking-wide text-ink/46">
              {info.ext}
            </span>
          )}
        </div>
        {info.previewMessage && (
          <p className="mt-3 text-xs leading-5 text-ink/45">{info.previewMessage}</p>
        )}
        {info.downloadUrl && (
          <a
            data-testid="file-artifact-download"
            href={info.downloadUrl}
            download={info.filename}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-action px-4 py-2 text-sm font-medium text-action-foreground shadow-sm transition-colors hover:bg-action-hover"
          >
            <Download size={15} />
            <span>{downloadLabel}</span>
          </a>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code renderer (Sandpack: html / svg / react / vanilla-js)
// ---------------------------------------------------------------------------

const moziDarkTheme: SandpackTheme = {
  colors: {
    surface1: "#0a0a0f",
    surface2: "#13131d",
    surface3: "#1a1a25",
    clickable: "#e4e4e7",
    base: "#e4e4e7",
    disabled: "#52525b",
    hover: "#f4f4f5",
    accent: "#6366f1",
    error: "#ef4444",
    errorSurface: "#1c1917",
  },
  syntax: {
    plain: "#e4e4e7",
    comment: { color: "#52525b", fontStyle: "italic" },
    keyword: "#c084fc",
    tag: "var(--link)",
    punctuation: "#a1a1aa",
    definition: "#67e8f9",
    property: "#fbbf24",
    static: "#fb923c",
    string: "#4ade80",
  },
  font: {
    body: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    size: "13px",
    lineHeight: "20px",
  },
};

function detectContentType(code: string): ContentType {
  const t = code.trim();
  if (/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(t)) return "svg";
  if (/\bimport\s+.*from\s+['"]react['"]/i.test(t) || /\buseState\b|\buseEffect\b/.test(t) || /\bexport\s+default\s+function\b/.test(t)) return "react";
  if (/^<!doctype\s+html/i.test(t) || /<html[\s>]/i.test(t) || /<body[\s>]/i.test(t)) return "html";
  if (/<[a-z][\s\S]*>/i.test(t) && !t.includes("import ")) return "html";
  return "vanilla-js";
}

function buildConfig(code: string, ct: ContentType): { template: SandpackPredefinedTemplate; files: SandpackFiles } {
  switch (ct) {
    case "svg": {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#0a0a0f}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
      return { template: "static", files: { "/index.html": { code: html, active: true } } };
    }
    case "html": {
      let html = code;
      if (!/<html[\s>]/i.test(code)) html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
      return { template: "static", files: { "/index.html": { code: html, active: true } } };
    }
    case "react":
      return { template: "react-ts", files: { "/App.tsx": { code, active: true } } };
    default: {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="app"></div><script src="./index.js"></script></body></html>`;
      return { template: "vanilla", files: { "/index.html": { code: html }, "/index.js": { code, active: true } } };
    }
  }
}

function normalizeStaticHtml(code: string, ct: ContentType): string {
  if (ct === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;min-height:100%;background:#0a0a0f}body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`;
  }
  if (/<html[\s>]/i.test(code)) return code;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
}

export function extractCode(artifact: Artifact): string | null {
  return extractArtifactCode(artifact);
}

export interface ArtifactDownload {
  filename: string;
  /** For text artifacts: raw text + mime. For images: a URL/data-URI to fetch. */
  text?: string;
  mime?: string;
  url?: string;
  direct?: boolean;
}

function slugifyTitle(title: string): string {
  const base = (title || "artifact").trim().replace(/[\s/\\:*?"<>|]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return base || "artifact";
}

export function isDocumentArtifact(artifact: Artifact): boolean {
  return resolveArtifactKind(artifact) === "document" && !!extractDocument(artifact);
}

/**
 * Render a document artifact's markdown to a standalone, print-ready HTML string
 * (reuses the same remark-gfm pipeline as the on-screen renderer, wrapped in
 * clean print typography). Used to export a real PDF via the browser's native
 * print-to-PDF — vector text, no extra dependency. Returns null if not a document.
 */
export function renderArtifactPrintHtml(artifact: Artifact): string | null {
  const md = extractDocument(artifact);
  if (!md) return null;
  const body = renderToStaticMarkup(
    <ReactMarkdown
      components={READING_MARKDOWN_COMPONENTS}
      rehypePlugins={[rehypeMarkdownHeadingIds]}
      remarkPlugins={[remarkGfm]}
    >
      {normalizeMarkdownTables(md)}
    </ReactMarkdown>,
  );
  const title = (artifact.title || "Document").replace(/[<>&]/g, "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    @page { margin: 20mm; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, "SF Pro Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", sans-serif; color: #1a1a1a; font-size: 15px; line-height: 1.7; max-width: 960px; margin: 0 auto; padding: 28px; overflow-wrap: break-word; }
    h1, h2, h3, h4, h5, h6 { margin: 15px 0; font-weight: 700; line-height: 1.25; break-after: avoid-page; }
    h1 { font-size: 30px; } h2 { font-size: 24px; } h3 { font-size: 20px; } h4 { font-size: 17px; } h5, h6 { font-size: 15px; }
    p { margin: 4px 0; line-height: 1.7; letter-spacing: .02em; } p:not(:first-child) { margin-top: .85em; } p:not(:last-child) { margin-bottom: .85em; }
    li { margin-block: .56em; } ul, ol { margin-block: .85em; margin-inline-start: 1em; padding-inline-start: 0; } ul > li, ol > li { margin-inline-start: 1em; }
    ul { list-style: none; } ul > li::before { content: '-'; position: absolute; display: inline-block; margin-inline: -1em .5em; opacity: .5; }
    a { color: #1a56db; }
    pre { background: #f5f5f7; border: 1px solid #e3e3e6; border-radius: 8px; padding: 14px; overflow: auto; font-size: .85em; }
    code { display: inline; margin-inline: .25em; padding: .2em .4em; border: 1px solid #e3e3e6; border-radius: .25em; background: #f0f0f2; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .875em; line-height: 1; }
    pre code { margin: 0; padding: 0; border: 0; background: transparent; font-size: 1em; line-height: inherit; }
    blockquote { margin: .85em 0; padding: 0 1em; border-left: 4px solid #cbd5e1; color: #475569; }
    .markdown-table-frame { overflow: auto hidden; border-radius: 8px; margin: .85em 0; box-shadow: 0 0 0 1px #d5d5da; }
    table { display: block; border-collapse: collapse; width: 100%; max-width: 100%; text-align: left; }
    tr { border-bottom: 1px solid #e3e3e6; } tr:last-child { border-bottom: 0; } thead { background: #f5f5f7; }
    th, td { min-width: 120px; padding: .75em 1em; text-align: left; vertical-align: top; }
    th { font-weight: 600; }
    img { max-width: 100%; margin-block: .85em; border-radius: 8px; } hr { margin: 2.25em 0; border: 0; border-bottom: 1px dashed #d5d5da; }
  </style></head><body>${body}</body></html>`;
}

/**
 * Describe how to save an artifact to disk in its native format:
 * markdown → .md, html → .html, svg → .svg, react → .tsx, js → .js, image → its
 * source URL. Returns null when there is nothing downloadable yet.
 */
export function getArtifactDownload(artifact: Artifact): ArtifactDownload | null {
  const kind = resolveArtifactKind(artifact);
  const slug = slugifyTitle(artifact.title);

  if (kind === "file") {
    const info = getFileArtifactInfo(artifact);
    return info?.downloadUrl ? { filename: info.filename, url: info.downloadUrl, direct: true } : null;
  }

  if (kind === "image") {
    const src = extractImageSrc(artifact);
    return src ? { filename: slug, url: src } : null;
  }

  if (kind === "document") {
    const md = extractDocument(artifact);
    return md ? { filename: `${slug}.md`, text: md, mime: "text/markdown" } : null;
  }

  const code = extractCode(artifact);
  if (!code) return null;
  const ct = String(artifact.data.content_type ?? "").toLowerCase() || detectContentType(code);
  const ext = ct === "svg" ? "svg" : ct === "react" ? "tsx" : ct === "javascript" || ct === "vanilla-js" ? "js" : "html";
  const mime = ext === "svg" ? "image/svg+xml" : ext === "html" ? "text/html" : "text/plain";
  return { filename: `${slug}.${ext}`, text: code, mime };
}

/** One web source entry inside a sources_v1 artifact (workbench source list). */
interface SourceEntry {
  title?: string | null;
  url: string;
  snippet?: string | null;
  hostname?: string | null;
}

function sourceEntries(artifact: Artifact): SourceEntry[] {
  const raw = artifact.data.sources;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is SourceEntry =>
    Boolean(entry && typeof (entry as SourceEntry).url === "string" && /^https?:\/\//i.test((entry as SourceEntry).url)),
  );
}

/**
 * Workbench source list (sources_v1): the evidence a research turn consulted,
 * as titled jump links with snippets. Client-synthesized from tool_event
 * sources — never persisted as an artifact of its own.
 */
export function SourcesRenderer({ artifact }: { artifact: Artifact }) {
  const entries = useMemo(() => sourceEntries(artifact), [artifact.data]);
  const { t } = useLocale();
  if (entries.length === 0) {
    return <div className="p-6 text-[13px] text-ink/40">{t("artifact.sources.empty")}</div>;
  }
  return (
    <div className="h-full overflow-y-auto p-3" data-testid="sources-renderer">
      <ul className="flex list-none flex-col gap-0.5 p-0">
        {entries.map((entry, index) => (
          <li key={`${entry.url}-${index}`} className="min-w-0">
            <a
              data-testid="sources-renderer-link"
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex min-w-0 flex-col gap-0.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-ink/[0.04]"
            >
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-5 text-ink/75 group-hover:text-ink/90">
                  {entry.title?.trim() || entry.hostname || entry.url}
                </span>
                <ExternalLink aria-hidden="true" className="h-3 w-3 shrink-0 self-center text-ink/25 opacity-0 transition-opacity group-hover:opacity-100" />
              </span>
              {entry.snippet?.trim() && (
                <span className="line-clamp-2 text-[12px] leading-5 text-ink/40">{entry.snippet.trim()}</span>
              )}
              <span className="truncate text-[11px] leading-4 text-ink/30">{entry.hostname ?? entry.url}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Workbench artifacts index (artifacts_v1, client-synthesized): every product
 * of a turn — deliverable, supporting, and workspace working notes — as a
 * compact list; clicking an entry opens it in this panel.
 */
export function ArtifactsIndexRenderer({ artifact, onOpen }: { artifact: Artifact; onOpen?: (artifact: Artifact) => void }) {
  const { locale, t } = useLocale();
  const entries = useMemo(() => {
    const raw = artifact.data.artifacts;
    return Array.isArray(raw) ? (raw as Artifact[]).filter((entry) => entry && typeof entry.id === "string") : [];
  }, [artifact.data]);
  if (entries.length === 0) {
    return <div className="p-6 text-[13px] text-ink/40">{t("artifact.artifacts.empty")}</div>;
  }
  return (
    <div className="h-full overflow-y-auto p-3" data-testid="artifacts-index-renderer">
      <ul className="flex list-none flex-col gap-0.5 p-0">
        {entries.map((entry) => {
          const info = getFileArtifactInfo(entry);
          const type = resolveArtifactType(entry);
          const roleKey = entry.data.role === "primary"
            ? "artifact.artifacts.rolePrimary"
            : entry.data.role === "supporting"
              ? "artifact.artifacts.roleSupporting"
              : "artifact.artifacts.roleWorkspace";
          return (
            <li key={entry.id} className="min-w-0">
              <button
                type="button"
                data-testid="artifacts-index-entry"
                onClick={() => onOpen?.(entry)}
                className="flex w-full min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors hover:bg-ink/[0.04]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center text-ink/45">
                  <TypeIcon type={type} size={22} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-5 text-ink/75">
                    {info?.filename ?? entry.title}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-ink/32">
                    {[t(roleKey as Parameters<typeof t>[0]), info ? formatFileSize(info.size, locale) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink/25" aria-hidden="true" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Disk is the render truth for completed code artifacts (root-cause decision
 * 2026-07-19). The timeline's `data.code` freezes at create_artifact time, but
 * the runtime legitimately lets the model keep working on the PERSISTED file —
 * real incident: a dashboard was carded as an 18KB template with a
 * `DATA_JSON_PLACEHOLDER`, then 113KB of processed UN data was injected into
 * the persisted file via shell. Every completion gate verified the DISK file
 * while the workbench rendered the stale snapshot — the user saw five empty
 * charts under a green 2/2 plan. When a completed artifact carries
 * `data.persisted_path`, fetch the file and render THAT; the snapshot remains
 * the live-streaming copy and the fallback when the file is unreachable.
 */
function usePersistedArtifactCode(artifact: Artifact): string | null {
  const persistedPath = typeof artifact.data?.persisted_path === "string" ? (artifact.data.persisted_path as string) : null;
  const eligible = artifact.status === "completed" && !!persistedPath;
  const fetchKey = eligible ? `${persistedPath}::${String(artifact.data?.version_number ?? "")}` : null;
  const [state, setState] = useState<{ key: string; code: string } | null>(null);

  useEffect(() => {
    if (!fetchKey || !persistedPath) return;
    const controller = new AbortController();
    fetch(`/api/fs/file?${new URLSearchParams({ path: persistedPath })}`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); })
      .then((body) => { if (body.trim()) setState({ key: fetchKey, code: body }); })
      .catch(() => { /* fall back to the snapshot */ });
    return () => controller.abort();
  }, [fetchKey, persistedPath]);

  return state?.key === fetchKey ? state.code : null;
}

export function CodeRenderer({ artifact, showCode }: { artifact: Artifact; showCode: boolean }) {
  const persistedCode = usePersistedArtifactCode(artifact);
  const code = useMemo(() => persistedCode ?? extractCode(artifact), [persistedCode, artifact.data]);
  const isLiveWriting = artifact.status === "running" && artifact.data.live_preview === true;
  const contentType = useMemo(() => {
    const explicit = artifact.data.content_type as string | undefined;
    if (explicit === "html" || explicit === "svg" || explicit === "react") return explicit as ContentType;
    if (explicit === "javascript") return "vanilla-js" as ContentType;
    return code ? detectContentType(code) : ("html" as ContentType);
  }, [code, artifact.data.content_type]);
  const staticHtml = useMemo(
    () => (code && (contentType === "html" || contentType === "svg") ? normalizeStaticHtml(code, contentType) : null),
    [code, contentType],
  );
  const config = useMemo(() => (code ? buildConfig(code, contentType) : null), [code, contentType]);

  if (!code) {
    return artifact.status === "running"
      ? <LiveWorkingState artifact={artifact} />
      : <EmptyState label="No content to preview" />;
  }

  // While the model is still writing, default to a calm "generating" state —
  // a user who asked for a deck should NOT be shown raw CSS/HTML streaming.
  // Raw code is opt-in via the </> toggle (showCode); the rendered preview
  // takes over on completion. (Half-written markup can't be safely iframed.)
  if (isLiveWriting) {
    return showCode ? <LiveCodeStream code={code} /> : <LiveWorkingState artifact={artifact} />;
  }

  if (staticHtml) {
    return (
      <div className="flex h-full min-h-0 bg-black">
        {showCode && (
          <div className="h-full w-[42%] min-w-[320px] overflow-auto border-r border-sheet/[0.06] bg-[#0a0a0f]">
            <pre className="m-0 whitespace-pre-wrap break-words p-4 font-mono text-[12px] leading-5 text-sheet/70">{code}</pre>
          </div>
        )}
        <iframe
          title={artifact.title}
          srcDoc={staticHtml}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads"
          className="h-full min-w-0 flex-1 border-0 bg-white"
        />
      </div>
    );
  }

  if (!config) return <EmptyState label="No content to preview" />;

  return (
    <SandpackProvider
      template={config.template}
      files={config.files}
      theme={moziDarkTheme}
      options={{ initMode: "immediate" }}
      style={{ height: "100%" }}
    >
      <SandpackLayout style={{ border: "none", borderRadius: 0, height: "100%", minHeight: 0 }}>
        {showCode && <SandpackCodeEditor showLineNumbers showTabs={false} style={{ height: "100%" }} />}
        <SandpackPreview showNavigator={false} showOpenInCodeSandbox={false} showRefreshButton style={{ height: "100%" }} />
      </SandpackLayout>
    </SandpackProvider>
  );
}

// ---------------------------------------------------------------------------

/** A fetch failure that means "the file is gone", not "the preview broke". */
export function isMissingFileError(message: string | null | undefined): boolean {
  return typeof message === "string" && /HTTP 404/.test(message);
}

/**
 * Honest terminal state for a card whose file no longer exists on disk
 * (operator decision 2026-07-19): name the file, say plainly that it was
 * removed after delivery, and show the original path — never a raw
 * "HTTP 404".
 */
export function MissingFileNotice({ info }: { info: FileArtifactInfo }) {
  const { t } = useLocale();
  return (
    <div data-testid="artifact-missing-file" className="flex h-full items-center justify-center px-6">
      <div className="max-w-[420px] text-center">
        <FileX className="mx-auto h-6 w-6 text-ink/25" aria-hidden="true" strokeWidth={1.6} />
        <p className="mt-3 text-sm font-medium text-ink/65">{info.filename}</p>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-ink/42">{t("artifact.file.missingDetail")}</p>
        {info.path && (
          <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-ink/28">{info.path}</p>
        )}
      </div>
    </div>
  );
}

export function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-ink/30">{label}</p>
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex items-center gap-2 text-sm text-ink/40">
        <Loader2 size={15} className="animate-spin text-activity" />
        <span>{label}</span>
      </div>
    </div>
  );
}

/**
 * Streaming code view for an artifact that is still being written. Follows the
 * tail (auto-scroll) unless the user scrolls up to inspect earlier output.
 */
export function LiveCodeStream({ code }: { code: string }) {
  const { locale, t } = useLocale();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const [expanded, setExpanded] = useState(true);
  const lineCount = useMemo(() => code ? code.split(/\r\n|\r|\n/).length : 0, [code]);
  const tailCode = useMemo(() => {
    const lines = code.split(/\r\n|\r|\n/);
    const lineTail = lines.length > LIVE_CODE_TAIL_LINES
      ? lines.slice(-LIVE_CODE_TAIL_LINES).join("\n")
      : code;
    return lineTail.length > LIVE_CODE_TAIL_CHARS ? lineTail.slice(-LIVE_CODE_TAIL_CHARS) : lineTail;
  }, [code]);
  const displayCode = expanded ? code : tailCode;
  const formattedChars = code.length.toLocaleString(locale);
  const formattedLines = lineCount.toLocaleString(locale);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight;
  }, [displayCode]);

  useEffect(() => {
    pinnedToBottom.current = true;
  }, [expanded]);

  return (
    <div data-testid="artifact-live-code" className="flex h-full min-h-0 flex-col bg-base p-3">
      <div
        data-testid="artifact-live-code-window"
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-lg border border-ink/[0.06] bg-[#0a0a0f]",
          expanded ? "h-full" : "max-h-[180px]",
        )}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-sheet/[0.05] px-3 py-2 text-[11.5px] text-sheet/45">
          <Loader2 size={12} className="animate-spin text-activity" />
          <span>{t("artifact.live.writing")}</span>
          <span data-testid="artifact-live-code-counts" className="min-w-0 truncate font-mono text-[10px] text-sheet/30">
            {t("artifact.live.progress", { chars: formattedChars, lines: formattedLines })}
          </span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10.5px] text-link/70 transition-colors hover:bg-ink/[0.04] hover:text-link-hover"
          >
            {expanded ? t("artifact.live.collapse") : t("artifact.live.expand")}
          </button>
        </div>
        <div className="h-px shrink-0 overflow-hidden bg-sheet/[0.04]">
          <div className="live-progress-indicator h-full w-1/3 bg-activity/70" />
        </div>
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
        >
          <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-sheet/60">
            {displayCode}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse rounded-[1px] bg-activity/80" />
          </pre>
        </div>
      </div>
    </div>
  );
}

export function LiveWorkingState({ artifact }: { artifact: Artifact }) {
  const { t } = useLocale();
  const phase = typeof artifact.data.phase === "string" ? artifact.data.phase : "preparing";
  const label = artifact.fallback_text || (phase === "writing" ? t("artifact.live.writing") : t("artifact.live.preparing"));
  return (
    <div className="flex h-full items-center justify-center px-8">
      <div className="w-full max-w-[520px]">
        <div className="mb-4 flex items-center gap-2 text-sm text-ink/54">
          <Loader2 size={15} className="animate-spin text-activity" />
          <span>{label}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-ink/[0.07]">
          <div className="live-progress-indicator h-full w-1/3 rounded-full bg-activity/75" />
        </div>
        <p className="mt-3 text-xs text-ink/28">
          {t("artifact.live.waitingForOutput")}
        </p>
      </div>
    </div>
  );
}
