import type { ReactNode } from "react";
import type { Artifact } from "@/types";
import { artifactContentLooksLikeStandaloneHtml } from "@/lib/file-artifact";

export type ArtifactType =
  | "html"
  | "react"
  | "svg"
  | "js"
  | "code"
  | "document"
  | "pdf"
  | "sheet"
  | "deck"
  | "image"
  | "archive"
  | "sources"
  | "file";

// Source/license: project-authored generic file-type glyphs, bundled as inline SVG with no third-party assets.
// No brand marks are embedded; colors follow common editor/chat file icon conventions.
const ICON_TYPES: ArtifactType[] = [
  "html",
  "react",
  "svg",
  "js",
  "code",
  "document",
  "pdf",
  "sheet",
  "deck",
  "image",
  "archive",
  "file",
];

const ICON_TYPE_SET = new Set<string>(ICON_TYPES);

const ICON_ALIASES: Record<string, ArtifactType> = {
  doc: "document",
  docx: "document",
  markdown: "document",
  md: "document",
  txt: "document",
  xls: "sheet",
  xlsx: "sheet",
  csv: "sheet",
  ppt: "deck",
  pptx: "deck",
  presentation: "deck",
  slides: "deck",
  jpg: "image",
  jpeg: "image",
  png: "image",
  gif: "image",
  webp: "image",
  json: "code",
  ts: "code",
  tsx: "react",
  jsx: "react",
  zip: "archive",
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "svg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xls", "csv", "tsv", "numbers", "ods"]);
const DECK_EXTENSIONS = new Set(["pptx", "ppt", "key", "odp"]);
const DOCUMENT_EXTENSIONS = new Set(["doc", "docx", "pages", "md", "markdown", "txt", "rtf", "odt"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const REACT_EXTENSIONS = new Set(["jsx", "tsx"]);
const JS_EXTENSIONS = new Set(["js", "mjs", "cjs"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz"]);
const CODE_EXTENSIONS = new Set([
  "json",
  "jsonl",
  "ts",
  "css",
  "scss",
  "less",
  "xml",
  "yaml",
  "yml",
  "toml",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "c",
  "cc",
  "cpp",
  "h",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
]);

function normalizeContentType(artifact: Artifact): string {
  return String(
    artifact.data.content_type ??
      artifact.data.mime_type ??
      artifact.data.mime ??
      artifact.data.kind ??
      artifact.data.ext ??
      artifact.plugin_id ??
      "",
  ).toLowerCase();
}

function normalizeFileExtension(artifact: Artifact): string {
  const ext = typeof artifact.data.ext === "string" ? artifact.data.ext : "";
  const filename = typeof artifact.data.filename === "string" ? artifact.data.filename : "";
  const raw = ext || filename.split(".").pop() || "";
  return raw.replace(/^\./, "").toLowerCase();
}

function codeLooksLikeHtml(code: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html\b|<head\b|<body\b|<[a-z][\w:-]*(?:\s|>|\/>))/i.test(code);
}

function codeLooksLikeSvg(code: string): boolean {
  return /^\s*<svg(?:\s|>)/i.test(code);
}

function resolveFileArtifactType(artifact: Artifact): ArtifactType {
  const kind = String(artifact.data.kind ?? "").toLowerCase();
  const mime = String(artifact.data.mime ?? artifact.data.mime_type ?? "").toLowerCase();
  const ext = normalizeFileExtension(artifact);

  if (kind === "image" || mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (kind === "sheet" || kind === "spreadsheet" || mime.includes("spreadsheet") || mime.includes("excel") || SHEET_EXTENSIONS.has(ext)) {
    return "sheet";
  }
  if (mime.includes("pdf") || ext === "pdf") return "pdf";
  if (
    kind === "deck" ||
    kind === "presentation" ||
    kind === "slides" ||
    mime.includes("presentation") ||
    mime.includes("powerpoint") ||
    DECK_EXTENSIONS.has(ext)
  ) {
    return "deck";
  }
  if (
    kind === "document" ||
    kind === "text" ||
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    mime.includes("markdown") ||
    mime.includes("text/plain") ||
    DOCUMENT_EXTENSIONS.has(ext)
  ) {
    return "document";
  }
  if (HTML_EXTENSIONS.has(ext) || mime.includes("text/html")) return "html";
  if (REACT_EXTENSIONS.has(ext)) return "react";
  if (JS_EXTENSIONS.has(ext) || mime.includes("javascript")) return "js";
  if (ARCHIVE_EXTENSIONS.has(ext) || kind === "archive" || mime.includes("zip") || mime.includes("tar") || mime.includes("compressed")) {
    return "archive";
  }
  if (CODE_EXTENSIONS.has(ext) || kind === "code" || mime.includes("json") || mime.includes("xml")) return "code";
  return "file";
}

export function resolveArtifactType(artifact: Artifact): ArtifactType {
  const type = normalizeContentType(artifact);
  const pluginId = (artifact.plugin_id ?? "").toLowerCase();

  if (pluginId === "file_v1") return resolveFileArtifactType(artifact);
  // Workbench source list (glyph falls back to the generic file icon).
  if (pluginId === "sources_v1") return "sources";
  if (artifactContentLooksLikeStandaloneHtml(artifact)) return "html";

  if (type.includes("pdf") || pluginId.includes("pdf")) return "pdf";
  if (
    type.includes("sheet") ||
    type.includes("spreadsheet") ||
    type.includes("csv") ||
    type.includes("xlsx") ||
    pluginId.includes("sheet")
  ) {
    return "sheet";
  }
  if (
    type.includes("deck") ||
    type.includes("presentation") ||
    type.includes("slides") ||
    type.includes("ppt") ||
    pluginId.includes("deck") ||
    pluginId.includes("presentation")
  ) {
    return "deck";
  }
  if (type.includes("image") || pluginId.includes("image") || typeof artifact.data.image_url === "string") return "image";
  if (type.includes("react")) return "react";
  if (type.includes("svg")) return "svg";
  if (type.includes("javascript") || type.includes("vanilla-js") || type === "js") return "js";
  if (type.includes("json") || type.includes("code")) return "code";
  if (type.includes("html")) return "html";
  if (
    type.includes("markdown") ||
    type.includes("document") ||
    type.includes("text") ||
    pluginId.includes("document") ||
    typeof artifact.data.markdown === "string"
  ) {
    return "document";
  }
  if (typeof artifact.data.code === "string") {
    if (codeLooksLikeSvg(artifact.data.code)) return "svg";
    if (codeLooksLikeHtml(artifact.data.code)) return "html";
    return "code";
  }
  return "file";
}

function normalizeIconType(type: ArtifactType | string): ArtifactType {
  const value = String(type).toLowerCase();
  return ICON_ALIASES[value] ?? (ICON_TYPE_SET.has(value) ? (value as ArtifactType) : "file");
}

function FileShape({
  body,
  fold,
  children,
}: {
  body: string;
  fold: string;
  children?: ReactNode;
}) {
  return (
    <>
      <path
        fill="#000"
        fillOpacity="0.16"
        d="M8.75 3h11.2L26 9.05v19.2c0 1.1-.9 2-2 2H8.75c-1.1 0-2-.9-2-2V5c0-1.1.9-2 2-2Z"
      />
      <path
        fill={body}
        d="M8 2.25h11.2l6.05 6.05V27.5c0 1.1-.9 2-2 2H8c-1.1 0-2-.9-2-2V4.25c0-1.1.9-2 2-2Z"
      />
      <path fill={fold} d="M19.2 2.25V7.8c0 1.1.9 2 2 2h4.05l-6.05-7.55Z" />
      <path fill="#fff" fillOpacity="0.18" d="M8 2.25h11.2v2.4H8c-1.1 0-2 .9-2 2v-2.4c0-1.1.9-2 2-2Z" />
      {children}
    </>
  );
}

function renderDocumentIcon() {
  return (
    <FileShape body="#2F80ED" fold="#8AC4FF">
      <rect x="10" y="12" width="12" height="1.8" rx="0.9" fill="#fff" fillOpacity="0.92" />
      <rect x="10" y="16" width="10.5" height="1.8" rx="0.9" fill="#fff" fillOpacity="0.78" />
      <rect x="10" y="20" width="8" height="1.8" rx="0.9" fill="#fff" fillOpacity="0.58" />
    </FileShape>
  );
}

function renderPdfIcon() {
  return (
    <FileShape body="#E53935" fold="#FF8A80">
      <rect x="9" y="17" width="14" height="6.2" rx="1.4" fill="#B71C1C" fillOpacity="0.34" />
      <text
        x="16"
        y="21.45"
        textAnchor="middle"
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
        fontSize="5.7"
        fontWeight="800"
        fill="#fff"
      >
        PDF
      </text>
      <path fill="#fff" fillOpacity="0.72" d="M10.25 12.2h8.8v1.6h-8.8z" />
    </FileShape>
  );
}

function renderSheetIcon() {
  return (
    <FileShape body="#27A65A" fold="#79D99E">
      <rect x="9.25" y="11.25" width="13.5" height="12" rx="1.5" fill="#fff" fillOpacity="0.95" />
      <path fill="#D7F5E3" d="M9.25 14.7h13.5v2.7H9.25zM9.25 20h13.5v1.65H9.25z" />
      <path fill="#27A65A" fillOpacity="0.86" d="M13 11.25h1.35v12H13zM17.9 11.25h1.35v12H17.9z" />
      <path fill="#27A65A" fillOpacity="0.68" d="M9.25 16.95h13.5v1.15H9.25z" />
    </FileShape>
  );
}

function renderDeckIcon() {
  return (
    <FileShape body="#F59E0B" fold="#FCD34D">
      <rect x="9.2" y="11.2" width="13.6" height="9.8" rx="1.6" fill="#fff" fillOpacity="0.95" />
      <rect x="11" y="13" width="7.4" height="1.45" rx="0.72" fill="#F97316" />
      <rect x="11" y="16" width="9.4" height="1.25" rx="0.62" fill="#FDBA74" />
      <path fill="#F97316" d="M15.25 21h1.5v2.6h-1.5zM11.75 23.25h8.5v1.35h-8.5z" />
    </FileShape>
  );
}

function renderImageIcon() {
  return (
    <FileShape body="#8B5CF6" fold="#C4B5FD">
      <rect x="9.25" y="11" width="13.5" height="11.5" rx="1.6" fill="#fff" fillOpacity="0.95" />
      <circle cx="19.25" cy="14.4" r="1.65" fill="#FBBF24" />
      <path fill="#22C55E" d="m10.45 20.95 3.7-4.2c.42-.48 1.16-.48 1.58 0l2.05 2.32.92-1.02c.42-.46 1.14-.46 1.56.02l1.45 1.65v1.05c0 .46-.37.83-.83.83H11.28a.83.83 0 0 1-.83-.65Z" />
      <path fill="#38BDF8" fillOpacity="0.35" d="M10.85 12.6h10.3v5.2l-.9-1.03a2.1 2.1 0 0 0-3.1-.05l-.08.09-.2-.23a2.55 2.55 0 0 0-3.86 0l-2.98 3.38V13.45c0-.47.38-.85.85-.85Z" />
    </FileShape>
  );
}

function renderHtmlIcon() {
  return (
    <FileShape body="#F97316" fold="#FDBA74">
      <path
        d="m13.1 13.1-4 4 4 4M18.9 13.1l4 4-4 4"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m17.05 12.2-2.1 10" fill="none" stroke="#FED7AA" strokeWidth="1.65" strokeLinecap="round" />
    </FileShape>
  );
}

function renderReactIcon() {
  return (
    <FileShape body="#123A4A" fold="#38BDF8">
      <circle cx="16" cy="17" r="2" fill="#61DAFB" />
      <ellipse cx="16" cy="17" rx="8" ry="3.1" fill="none" stroke="#61DAFB" strokeWidth="1.35" />
      <ellipse cx="16" cy="17" rx="8" ry="3.1" fill="none" stroke="#61DAFB" strokeWidth="1.35" transform="rotate(60 16 17)" />
      <ellipse cx="16" cy="17" rx="8" ry="3.1" fill="none" stroke="#61DAFB" strokeWidth="1.35" transform="rotate(120 16 17)" />
    </FileShape>
  );
}

function renderJsIcon() {
  return (
    <FileShape body="#F7DF1E" fold="#FFE97A">
      <rect x="9.5" y="16.25" width="13" height="7.25" rx="1.3" fill="#1F2937" fillOpacity="0.12" />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="Inter, ui-sans-serif, system-ui, sans-serif"
        fontSize="7.5"
        fontWeight="900"
        fill="#27272A"
      >
        JS
      </text>
    </FileShape>
  );
}

function renderCodeIcon() {
  return (
    <FileShape body="#64748B" fold="#CBD5E1">
      <path
        d="m13 13.2-3.8 3.8 3.8 3.8M19 13.2l3.8 3.8-3.8 3.8"
        fill="none"
        stroke="#fff"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m17.05 12.3-2.1 9.4" fill="none" stroke="#C4B5FD" strokeWidth="1.55" strokeLinecap="round" />
    </FileShape>
  );
}

function renderSvgIcon() {
  return (
    <FileShape body="#A855F7" fold="#D8B4FE">
      <path d="M11 20.4c2.7-7 7.25-8.3 10.2-3.1" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="11" cy="20.4" r="2.25" fill="#FDE68A" />
      <circle cx="21.2" cy="17.3" r="2.25" fill="#67E8F9" />
      <circle cx="16.2" cy="12.6" r="2" fill="#F9A8D4" />
      <path d="M12.85 19.15 15 14.2M18 13.8l1.95 2" stroke="#fff" strokeWidth="1.25" strokeLinecap="round" />
    </FileShape>
  );
}

function renderArchiveIcon() {
  return (
    <FileShape body="#8B6F47" fold="#D6B27A">
      <rect x="12.5" y="9.6" width="4.1" height="15.2" rx="0.7" fill="#FDE68A" />
      <path fill="#7C2D12" fillOpacity="0.78" d="M12.5 11.6h2v1.6h-2zM14.6 13.3h2v1.6h-2zM12.5 15h2v1.6h-2zM14.6 16.7h2v1.6h-2zM12.5 18.4h2V20h-2zM14.6 20.1h2v1.6h-2z" />
      <rect x="17.7" y="15.3" width="4.7" height="6.6" rx="1.2" fill="#F97316" />
      <rect x="18.8" y="16.8" width="2.5" height="1.2" rx="0.6" fill="#FFEDD5" />
    </FileShape>
  );
}

function renderFileIcon() {
  return (
    <FileShape body="#94A3B8" fold="#CBD5E1">
      <rect x="10.25" y="13" width="11.5" height="1.75" rx="0.85" fill="#fff" fillOpacity="0.75" />
      <rect x="10.25" y="17" width="9.5" height="1.75" rx="0.85" fill="#fff" fillOpacity="0.55" />
      <rect x="10.25" y="21" width="6.75" height="1.75" rx="0.85" fill="#fff" fillOpacity="0.4" />
    </FileShape>
  );
}

const ICON_RENDERERS: Record<ArtifactType, () => ReactNode> = {
  html: renderHtmlIcon,
  react: renderReactIcon,
  svg: renderSvgIcon,
  js: renderJsIcon,
  code: renderCodeIcon,
  document: renderDocumentIcon,
  pdf: renderPdfIcon,
  sheet: renderSheetIcon,
  deck: renderDeckIcon,
  image: renderImageIcon,
  archive: renderArchiveIcon,
  file: renderFileIcon,
};

export function TypeIcon({ type, size = 28 }: { type: ArtifactType | string; size?: number }) {
  const normalized = normalizeIconType(type);
  const pixelSize = Math.max(12, Math.round(size));

  return (
    <span
      aria-hidden="true"
      data-testid="artifact-type-icon"
      data-type={normalized}
      className="inline-flex shrink-0 items-center justify-center"
      style={{ width: pixelSize, height: pixelSize }}
    >
      <svg
        width={pixelSize}
        height={pixelSize}
        viewBox="0 0 32 32"
        data-icon-type={normalized}
        className="block"
      >
        {ICON_RENDERERS[normalized]()}
      </svg>
    </span>
  );
}
