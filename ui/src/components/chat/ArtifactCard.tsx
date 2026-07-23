import { ChevronRight, Download } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { Artifact } from "@/types";
import { useLocale, type MessageKey } from "@/i18n";
import { resolveArtifactKind, formatFileSize, getFileArtifactInfo, type FileArtifactInfo } from "@/lib/file-artifact";
import { TypeIcon, resolveArtifactType } from "./artifact-type-icons";

interface ArtifactCardProps {
  artifact: Artifact;
  onOpen?: (artifact: Artifact) => void;
}

const META_SEPARATOR = " · ";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function inferExtension(filename: string): string {
  const parts = filename.split(".");
  const candidate = parts.length > 1 ? parts.pop()?.trim().toLowerCase() ?? "" : "";
  // Only real extensions — a title like "报告 (2026.7.13-7.18)" must not
  // surface "18)" as its type ("Document · 18)").
  return /^[a-z][a-z0-9]{0,7}$/.test(candidate) ? candidate : "";
}

function artifactExtension(artifact: Artifact, fileInfo: FileArtifactInfo | null): string {
  const raw =
    fileInfo?.ext ||
    stringValue(artifact.data.ext) ||
    stringValue(artifact.data.extension) ||
    inferExtension(stringValue(artifact.data.filename)) ||
    inferExtension(artifact.title);

  return raw.replace(/^\./, "").toLowerCase();
}

function shouldShowExtension(type: string, ext: string): boolean {
  if (!ext) return false;
  return type !== ext;
}

function joinMeta(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join(META_SEPARATOR);
}

/**
 * Inline chip for an artifact in the chat timeline. Deliberately compact —
 * a bounded attachment-style card, not a full-width banner — with a metadata
 * subtitle (type, extension, size) instead of raw content fragments, so it
 * reads as quiet conversation content rather than a preview surface.
 */
export default function ArtifactCard({ artifact, onOpen }: ArtifactCardProps) {
  const { locale, t } = useLocale();
  const kind = resolveArtifactKind(artifact);
  const fileInfo = kind === "file" ? getFileArtifactInfo(artifact) : null;
  const type = resolveArtifactType(artifact);
  const typeLabel = t(`artifact.type.${type}` as MessageKey);
  const isRunning = artifact.status === "running";
  const isFailed = artifact.status === "failed";
  const title = fileInfo?.filename ?? artifact.title;
  const ext = artifactExtension(artifact, fileInfo);
  const extensionLabel = shouldShowExtension(type, ext) ? ext.toUpperCase() : "";
  const fileSizeLabel = fileInfo ? formatFileSize(fileInfo.size, locale) : "";
  const actionLabel = isRunning ? t("artifact.status.running") : t("artifact.open");
  // The turn's primary deliverable (server-stamped role, Issue #735) reads as
  // the hero of the answer, not an attachment chip. Only a finished, healthy
  // deliverable earns the treatment — running/failed states keep the quiet
  // chip with their truthful status line.
  const isHero = artifact.data.role === "primary" && !isRunning && !isFailed;

  const subtitle = (() => {
    if (isRunning) {
      return artifact.fallback_text?.trim() || joinMeta([typeLabel, t("artifact.status.running")]);
    }
    if (isFailed) return joinMeta([typeLabel, extensionLabel, t("artifact.status.failed")]);
    // Liveness truth beats the frozen size: the file vanished after delivery
    // (deliverable-shelf sweep, 2026-07-19) — the card says so up front.
    if (fileInfo?.missing) return joinMeta([typeLabel, extensionLabel, t("artifact.file.missing")]);
    if (fileInfo) return joinMeta([typeLabel, extensionLabel, fileSizeLabel]);
    return joinMeta([typeLabel, extensionLabel]);
  })();

  const openArtifact = () => onOpen?.(artifact);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openArtifact();
    }
  };

  if (isHero) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={openArtifact}
        onKeyDown={handleKeyDown}
        data-testid="artifact-card"
        data-artifact-kind={kind}
        data-variant="hero"
        className="group flex w-full max-w-[520px] cursor-pointer items-center gap-3 rounded-lg bg-ink/[0.03] py-3 pl-3.5 pr-3 text-left shadow-[inset_0_0_0_1px_rgba(var(--ink-rgb),0.05)] transition-[background-color,box-shadow] duration-150 hover:bg-ink/[0.05] hover:shadow-[inset_0_0_0_1px_rgba(var(--ink-rgb),0.09)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
      >
        <div
          data-testid="artifact-card-icon-slot"
          className="flex h-10 w-10 shrink-0 items-center justify-center text-ink/55"
        >
          <TypeIcon type={type} size={34} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13.5px] font-semibold leading-5 text-ink/85 transition-colors group-hover:text-ink/95">
            {title}
          </p>
          <p className="mt-0.5 truncate text-[11.5px] leading-4 text-ink/38">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md bg-action/[0.13] px-2.5 py-1.5 text-[12px] font-medium leading-none text-action transition-colors group-hover:bg-action/[0.19]">
            {actionLabel}
            <ChevronRight size={11} />
          </span>
          {fileInfo?.downloadUrl && (
            <a
              data-testid="artifact-card-download"
              href={fileInfo.downloadUrl}
              download={fileInfo.filename}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              title={t("artifact.download")}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-[12px] font-medium leading-none text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
            >
              <Download size={13} />
              <span>{t("artifact.download")}</span>
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openArtifact}
      onKeyDown={handleKeyDown}
      data-testid="artifact-card"
      data-artifact-kind={kind}
      className="group flex w-full max-w-[460px] cursor-pointer items-center gap-2.5 rounded-lg border border-ink/[0.06] bg-ink/[0.02] px-3 py-2 text-left transition-[background-color,border-color,box-shadow] duration-150 hover:border-ink/[0.12] hover:bg-ink/[0.04] hover:shadow-[0_1px_0_rgba(15,23,42,0.03)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
    >
      <div
        data-testid="artifact-card-icon-slot"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-base/40 text-ink/45"
      >
        <TypeIcon type={type} size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium leading-5 text-ink/78 transition-colors group-hover:text-ink/88">
          {title}
        </p>
        <p className="flex items-center gap-1.5 truncate text-[11px] leading-4 text-ink/38">
          {isFailed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-400/70" />}
          <span className="truncate">{subtitle}</span>
        </p>
      </div>
      {fileInfo?.downloadUrl ? (
        <a
          data-testid="artifact-card-download"
          href={fileInfo.downloadUrl}
          download={fileInfo.filename}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-ink/42 transition-colors hover:bg-ink/[0.05] hover:text-ink/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink/10"
        >
          <Download size={12} />
          <span>{t("artifact.download")}</span>
        </a>
      ) : (
        <span className="shrink-0 rounded-md px-1 py-0.5 text-[11px] font-medium text-ink/38 transition-colors group-hover:text-ink/58">
          {actionLabel}
        </span>
      )}
      <ChevronRight
        size={13}
        className="shrink-0 text-ink/24 transition-colors duration-150 group-hover:text-ink/45"
      />
    </div>
  );
}
