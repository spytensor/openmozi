import { useMemo, useRef, useState, useEffect } from "react";
import { Check, Copy, Download, MoreHorizontal, PanelRight } from "lucide-react";
import type { Artifact } from "@/types";
import { useLocale } from "@/i18n";
import { extractArtifactCode as extractCode } from "@/lib/file-artifact";

/**
 * Inline visualization card (four-region model, region 2): a chart/SVG/small
 * HTML snippet authored as part of the ANSWER renders directly in the
 * conversation — bounded height, sandboxed, with a quiet actions menu
 * (copy code / download / open in workbench). File-type outputs and workspace
 * working notes never take this path (presentation matrix).
 */

const INLINE_MAX_SVG_CHARS = 120_000;
/**
 * html/js inline cap is CHART-scale on purpose: a multi-section report
 * squeezed into a bounded inline frame is unreadable and hides its one-click
 * open behind the ⋯ menu — a document that size is a deliverable and renders
 * as a click-to-open artifact card instead.
 */
const INLINE_MAX_HTML_CHARS = 30_000;
const INLINE_TYPES = new Set(["svg", "html", "vanilla-js", "javascript"]);

/**
 * A FULL standalone HTML page (`<!doctype>`/`<html>` shell) is a document
 * deliverable — pages are read, not glanced — and must render as the
 * click-to-open artifact card. Only fragments (a chart div + its script)
 * qualify for the inline frame. This is the create_artifact authoring
 * contract's runtime side: charts are fragments, reports are pages.
 */
function isStandaloneHtmlPage(code: string): boolean {
  return /^\s*(?:<!doctype\b|<html\b)/i.test(code);
}

export function isInlineVisualArtifact(artifact: Artifact): boolean {
  if (artifact.status !== "completed") return false;
  if (artifact.data.role === "workspace") return false;
  const pluginId = (artifact.plugin_id ?? "").toLowerCase();
  if (pluginId === "file_v1" || pluginId.startsWith("document")) return false;
  const contentType = String(artifact.data.content_type ?? "").toLowerCase();
  if (!INLINE_TYPES.has(contentType)) return false;
  const code = extractCode(artifact);
  if (!code) return false;
  if (contentType === "svg") return code.length <= INLINE_MAX_SVG_CHARS;
  if (isStandaloneHtmlPage(code)) return false;
  return code.length <= INLINE_MAX_HTML_CHARS;
}

/**
 * The frame adopts the graphic's own aspect ratio (from viewBox or explicit
 * width/height) instead of a fixed height — a 1.6:1 SVG in a 2.1:1 box was
 * letterboxed with dead side margins. Clamped so a degenerate ratio can never
 * produce a sliver or a tower.
 */
function visualAspectRatio(code: string, contentType: string): number {
  const fallback = 16 / 9;
  if (contentType !== "svg") return fallback;
  const viewBox = code.match(/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (viewBox) {
    const width = Number(viewBox[1]);
    const height = Number(viewBox[2]);
    if (width > 0 && height > 0) return width / height;
  }
  const w = code.match(/<svg[^>]*\swidth\s*=\s*["']?([\d.]+)/i);
  const h = code.match(/<svg[^>]*\sheight\s*=\s*["']?([\d.]+)/i);
  if (w && h && Number(w[1]) > 0 && Number(h[1]) > 0) return Number(w[1]) / Number(h[1]);
  return fallback;
}

const FRAME_MIN_RATIO = 720 / 460; // never taller than 460px at full card width
const FRAME_MAX_RATIO = 720 / 220; // never shorter than 220px

/**
 * No-network Content-Security-Policy for inline conversation cards. The
 * `sandbox` attribute does NOT block network — without this, a CDN-referencing
 * visual works online and breaks offline/exported, and chat history stops
 * being reproducible. This makes the create_artifact authoring contract
 * ("fully self-contained") enforced truth instead of an unverified claim:
 * inline scripts/styles run, embedded data: assets render, remote loads don't.
 */
const INLINE_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:;">`;

function inlineDocument(code: string, contentType: string): string {
  if (contentType === "svg") {
    // A viewBox-only SVG collapses to 0×0 under max-width/height in a flex
    // box — size it explicitly. Deliberate near-white paper ground: model
    // charts assume light paper, and a sandboxed srcdoc paints an opaque
    // default anyway (never rely on it).
    return `<!doctype html><html><head><meta charset="utf-8">${INLINE_CSP}<style>html,body{margin:0;height:100%;background:#fbfbfa}svg{display:block;width:100%;height:100%}</style></head><body>${code}</body></html>`;
  }
  // Inline html/js is a FRAGMENT by contract (full pages render as artifact
  // cards) — wrap it in our own shell so the CSP precedes every author
  // script and the fragment gets a clean zero-margin light paper ground.
  return `<!doctype html><html><head><meta charset="utf-8">${INLINE_CSP}<style>html,body{margin:0;background:#fbfbfa}</style></head><body>${code}</body></html>`;
}

export default function InlineVisualCard({ artifact, onOpen }: { artifact: Artifact; onOpen?: (artifact: Artifact) => void }) {
  const { t } = useLocale();
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const code = useMemo(() => extractCode(artifact) ?? "", [artifact]);
  const contentType = String(artifact.data.content_type ?? "html").toLowerCase();
  const srcDoc = useMemo(() => inlineDocument(code, contentType), [code, contentType]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuOpen]);

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard unavailable — the workbench code view remains the fallback.
    }
    setMenuOpen(false);
  };

  const downloadCode = () => {
    const ext = contentType === "svg" ? "svg" : contentType === "html" ? "html" : "js";
    const mime = contentType === "svg" ? "image/svg+xml" : "text/plain";
    const url = URL.createObjectURL(new Blob([code], { type: mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${(artifact.title || "visual").replace(/[^\w一-鿿-]+/g, "_").slice(0, 48)}.${ext}`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMenuOpen(false);
  };

  return (
    <div
      data-testid="inline-visual-card"
      className="w-full max-w-[720px] overflow-hidden rounded-lg bg-ink/[0.02] shadow-[inset_0_0_0_1px_rgba(var(--ink-rgb),0.06)]"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        {onOpen ? (
          <button
            type="button"
            data-testid="inline-visual-title-open"
            onClick={() => onOpen(artifact)}
            className="min-w-0 flex-1 truncate text-left text-[12.5px] font-medium text-ink/60 transition-colors hover:text-ink/85"
          >
            {artifact.title}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink/60">{artifact.title}</span>
        )}
        <div ref={menuRef} className="relative shrink-0">
          <button
            type="button"
            aria-label={t("artifact.inline.menu")}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((value) => !value)}
            className="flex h-6 w-6 items-center justify-center rounded-md text-ink/35 transition-colors hover:bg-ink/[0.06] hover:text-ink/65"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-7 z-20 min-w-[168px] rounded-lg border border-ink/[0.08] bg-elevated py-1 shadow-xl">
              <button type="button" data-testid="inline-visual-copy" onClick={() => void copyCode()} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink/70 hover:bg-ink/[0.05]">
                {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                {copied ? t("artifact.inline.copied") : t("artifact.inline.copyCode")}
              </button>
              <button type="button" data-testid="inline-visual-download" onClick={downloadCode} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink/70 hover:bg-ink/[0.05]">
                <Download size={13} />
                {t("artifact.download")}
              </button>
              {onOpen && (
                <button type="button" data-testid="inline-visual-open-panel" onClick={() => { setMenuOpen(false); onOpen(artifact); }} className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink/70 hover:bg-ink/[0.05]">
                  <PanelRight size={13} />
                  {t("artifact.inline.openPanel")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Bounded body: height follows the graphic's aspect ratio (clamped),
          sandboxed, scripts allowed for chart interactivity but no
          same-origin access. Never auto-expands. */}
      <iframe
        data-testid="inline-visual-frame"
        title={artifact.title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="block w-full border-0 bg-transparent"
        style={{ aspectRatio: String(Math.min(Math.max(visualAspectRatio(code, contentType), FRAME_MIN_RATIO), FRAME_MAX_RATIO)) }}
      />
    </div>
  );
}
