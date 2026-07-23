import type { Artifact } from "@/types";

export type ArtifactKind = "code" | "document" | "image" | "file" | "sources" | "artifacts" | "unknown";

export interface FileArtifactInfo {
  path: string | null;
  filename: string;
  ext: string;
  size: number | null;
  mime: string;
  kind: string;
  previewable: boolean;
  previewUrl: string | null;
  previewRows: string[][] | null;
  previewRowsTruncated: boolean;
  previewMessage: string | null;
  downloadUrl: string | null;
  /** Server-carried liveness flag: the carded file vanished from disk. */
  missing: boolean;
}

const CODE_CONTENT_TYPES = new Set(["html", "svg", "react", "javascript", "vanilla-js"]);
const DOC_CONTENT_TYPES = new Set(["markdown", "md", "document", "text", "richtext"]);

export function artifactContentLooksLikeStandaloneHtml(artifact: Artifact): boolean {
  const content = [artifact.data.code, artifact.data.markdown, artifact.data.content, artifact.data.html]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  if (!content) return false;
  const value = content.replace(/^\uFEFF/, "").trimStart();
  return /^<!doctype\s+html(?:\s|>)/i.test(value) || /^<html(?:\s|>)/i.test(value);
}

export function resolveArtifactKind(artifact: Artifact): ArtifactKind {
  const pluginId = (artifact.plugin_id ?? "").toLowerCase();
  const contentType = String(artifact.data.content_type ?? "").toLowerCase();
  if (pluginId === "file_v1") return "file";
  if (pluginId === "sources_v1") return "sources";
  if (pluginId === "artifacts_v1") return "artifacts";
  if (artifactContentLooksLikeStandaloneHtml(artifact)) return "code";
  if (pluginId.startsWith("document") || DOC_CONTENT_TYPES.has(contentType)) return "document";
  if (pluginId.startsWith("image") || contentType === "image" || typeof artifact.data.image_url === "string") return "image";
  if (pluginId.startsWith("sandpack") || CODE_CONTENT_TYPES.has(contentType)) return "code";
  if (typeof artifact.data.markdown === "string" || typeof artifact.data.text === "string") return "document";
  if (["code", "content", "html", "svg", "source"].some((key) => typeof artifact.data[key] === "string" && String(artifact.data[key]).trim())) return "code";
  return "unknown";
}


/** The renderable source of a code/visual artifact (light helper — safe for the entry bundle). */
export function extractArtifactCode(artifact: Artifact): string | null {
  const d = artifact.data;
  for (const key of ["code", "content", "html", "svg", "source"]) {
    if (typeof d[key] === "string" && (d[key] as string).trim()) return d[key] as string;
  }
  if (artifactContentLooksLikeStandaloneHtml(artifact) && typeof d.markdown === "string") return d.markdown;
  return null;
}

export function isFileArtifact(artifact: Artifact): boolean {
  return (artifact.plugin_id ?? "").toLowerCase() === "file_v1";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function stringMatrixValue(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter((row): row is unknown[] => Array.isArray(row)).map((row) => row.map((cell) => String(cell ?? "")));
  return rows.length > 0 ? rows : null;
}

/**
 * Lightweight helpers for treating a workspace file as an artifact. Kept free
 * of heavy renderer deps (sandpack/pdfjs/mammoth/xlsx) so chat bubbles and the
 * Files page can import them without pulling the whole artifact renderer bundle.
 */

export function fileDownloadUrl(path: string): string {
  return `/api/fs/file?path=${encodeURIComponent(path)}`;
}

export function getFileArtifactInfo(artifact: Artifact): FileArtifactInfo | null {
  if (!isFileArtifact(artifact)) return null;
  const data = artifact.data;
  const path = stringValue(data.path);
  const filename = stringValue(data.filename) ?? (path ? basename(path) : null) ?? artifact.title;
  const ext = (stringValue(data.ext) ?? inferExtension(filename)).replace(/^\./, "").toLowerCase();
  const previewRows = stringMatrixValue(data.previewRows);
  return {
    path,
    filename,
    ext,
    size: numberValue(data.size),
    mime: stringValue(data.mime) ?? stringValue(data.mime_type) ?? "",
    kind: stringValue(data.kind) ?? "",
    previewable: data.previewable === true,
    previewUrl: stringValue(data.previewUrl),
    previewRows,
    previewRowsTruncated: data.previewRowsTruncated === true,
    previewMessage: stringValue(data.previewMessage),
    downloadUrl: stringValue(data.downloadUrl) ?? (path ? fileDownloadUrl(path) : null),
    missing: data.missing === true,
  };
}

export function formatFileSize(size: number | null | undefined, locale: string): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  if (size < 1024) return `${Math.round(size)} B`;
  let value = size;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 0 : 1 }).format(value)} ${units[unitIndex]}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function inferExtension(filename: string): string {
  const last = filename.split(".").pop();
  return last && last !== filename ? last.replace(/^\./, "").toLowerCase() : "";
}

/**
 * Build a synthetic `file_v1` artifact from a workspace file path so any file
 * (uploaded attachment, Files-page entry) opens in the same artifact panel that
 * renders agent-produced artifacts. The renderers fetch content client-side via
 * /api/fs/file, so a path is all that's needed.
 */
export function buildFileArtifact(input: {
  path: string;
  filename?: string;
  mime?: string;
  size?: number;
  timestamp?: number;
  deliverableId?: string;
}): Artifact {
  const filename = input.filename || basename(input.path) || "file";
  const ext = inferExtension(filename);
  return {
    id: `file:${input.path}`,
    plugin_id: "file_v1",
    title: filename,
    status: "complete",
    data: {
      path: input.path,
      filename,
      ext,
      previewable: true,
      ...(input.mime ? { mime: input.mime } : {}),
      ...(typeof input.size === "number" ? { size: input.size } : {}),
      ...(input.deliverableId ? { deliverableId: input.deliverableId } : {}),
    },
    timestamp: input.timestamp ?? 0,
  };
}
