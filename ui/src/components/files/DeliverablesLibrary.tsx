import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, Download, Eye, Loader2, MessageSquarePlus, Paperclip, Search, X } from "lucide-react";
import { TypeIcon } from "@/components/chat/artifact-type-icons";
import { buildFileArtifact, fileDownloadUrl } from "@/lib/file-artifact";
import { formatRelativeTimeForLocale, useLocale } from "@/i18n";
import { useApi } from "@/hooks/useApi";
import type { Artifact } from "@/types";

/**
 * The cross-session deliverable library — the default Files page (operator
 * decision 2026-07-19): "my files" means the things MOZI produced for me,
 * grouped by the CONVERSATION that made them (session titles, never UUIDs),
 * newest first. Raw folder browsing is the secondary page.
 */
export interface LibraryDeliverable {
  artifactId: string;
  path: string;
  filename: string;
  size: number;
  timestamp: number;
  role: "primary" | "supporting";
  kind?: string;
  ext?: string;
  turnId?: string;
  deliverableId?: string | null;
  versionCount?: number | null;
}

export interface LibraryGroup {
  sessionId: string;
  sessionTitle: string;
  latestTimestamp: number;
  deliverables: LibraryDeliverable[];
}

interface DeliverablesLibraryProps {
  onOpenArtifact?: (artifact: Artifact) => void;
  onOpenSession?: (sessionId: string) => void;
  onAttachToChat?: (payload: { path: string; filename: string }) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

export default function DeliverablesLibrary({ onOpenArtifact, onOpenSession, onAttachToChat }: DeliverablesLibraryProps) {
  const { get, post } = useApi();
  const { t, locale } = useLocale();
  const [groups, setGroups] = useState<LibraryGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [expandedSupporting, setExpandedSupporting] = useState<Set<string>>(() => new Set());
  const [continuingId, setContinuingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await get<{ groups: LibraryGroup[] }>("/api/fs/deliverables");
    setLoading(false);
    if (err || !data) {
      setError(err || t("files.error.load"));
      return;
    }
    setGroups(Array.isArray(data.groups) ? data.groups : []);
  }, [get, t]);

  useEffect(() => { void load(); }, [load]);

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return groups;
    return groups
      .map((group) => {
        const titleHit = group.sessionTitle.toLowerCase().includes(query);
        const deliverables = titleHit
          ? group.deliverables
          : group.deliverables.filter((entry) => entry.filename.toLowerCase().includes(query));
        return { ...group, deliverables };
      })
      .filter((group) => group.deliverables.length > 0);
  }, [groups, search]);

  const openFile = (entry: LibraryDeliverable) => {
    onOpenArtifact?.(buildFileArtifact({
      path: entry.path,
      filename: entry.filename,
      size: entry.size,
      timestamp: entry.timestamp,
      ...(entry.deliverableId ? { deliverableId: entry.deliverableId } : {}),
    }));
  };

  const toggleSupporting = (sessionId: string) => {
    setExpandedSupporting((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const continueInNewSession = async (entry: LibraryDeliverable) => {
    if (!entry.deliverableId || !onOpenSession) return;
    setContinuingId(entry.deliverableId);
    setError(null);
    const { data, error: requestError } = await post<{ session_id: string }>(
      `/api/deliverables/${encodeURIComponent(entry.deliverableId)}/continue`,
      {},
    );
    setContinuingId(null);
    if (requestError || !data?.session_id) {
      setError(requestError || t("files.continue.error"));
      return;
    }
    onOpenSession(data.session_id);
  };

  const renderRow = (entry: LibraryDeliverable) => (
    <div
      key={entry.path}
      className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-ink/[0.045] px-3 py-2.5 last:border-b-0 hover:bg-ink/[0.02]"
    >
      <button type="button" onClick={() => openFile(entry)} className="flex min-w-0 items-center gap-3 text-left">
        <TypeIcon type={entry.ext || entry.filename.split(".").pop() || "file"} size={32} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-ink/80">{entry.filename}</span>
          <span className="block truncate text-[10.5px] text-ink/34">
            {formatSize(entry.size)} · {formatRelativeTimeForLocale(entry.timestamp, locale)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1 opacity-100 md:opacity-0 md:transition-opacity md:group-hover:opacity-100 md:focus-within:opacity-100">
        <button type="button" title={t("files.open")} onClick={() => openFile(entry)} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink/70">
          <Eye className="h-3.5 w-3.5" />
        </button>
        <a href={fileDownloadUrl(entry.path)} download title={t("files.download")} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink/70">
          <Download className="h-3.5 w-3.5" />
        </a>
        {entry.deliverableId && onOpenSession && (
          <button
            type="button"
            title={t("files.continue")}
            aria-label={t("files.continue")}
            disabled={continuingId !== null}
            onClick={() => void continueInNewSession(entry)}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-link-hover disabled:cursor-not-allowed disabled:text-ink/25"
          >
            {continuingId === entry.deliverableId
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <MessageSquarePlus className="h-3.5 w-3.5" />}
          </button>
        )}
        {onAttachToChat && (
          <button type="button" title={t("files.attachToChat")} onClick={() => onAttachToChat({ path: entry.path, filename: entry.filename })} className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink/70">
            <Paperclip className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="deliverables-library">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border px-2.5"
          style={{ borderColor: "var(--border-medium)", background: "var(--surface-input)" }}
        >
          <Search className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("files.library.search")}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink/30"
            style={{ color: "var(--text-primary)" }}
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} title={t("files.clearSearch")}>
              <X className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
            </button>
          )}
        </label>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="underline underline-offset-2">{t("common.retry")}</button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 px-4 py-10 text-[12.5px] text-ink/40">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("common.loading")}
        </div>
      ) : visibleGroups.length === 0 ? (
        <p className="px-1 py-10 text-center text-[12.5px] text-ink/38">
          {search ? t("files.noMatches") : t("files.library.empty")}
        </p>
      ) : (
        visibleGroups.map((group) => {
          const primary = group.deliverables.filter((entry) => entry.role === "primary");
          const supporting = group.deliverables.filter((entry) => entry.role === "supporting");
          const supportingOpen = expandedSupporting.has(group.sessionId);
          return (
            <section key={group.sessionId} data-testid="library-session-group">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-1 pb-1.5">
                <div className="flex min-w-0 items-baseline gap-2">
                  <h2 className="min-w-0 truncate text-[13px] font-medium text-ink/72">{group.sessionTitle}</h2>
                  <span className="shrink-0 text-[11px] text-ink/34">{formatRelativeTimeForLocale(group.latestTimestamp, locale)}</span>
                </div>
                {onOpenSession && (
                  <button
                    type="button"
                    onClick={() => onOpenSession(group.sessionId)}
                    className="inline-flex shrink-0 items-center gap-1 text-[12px] text-ink/42 transition-colors hover:text-link-hover"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    {t("files.library.openChat")}
                  </button>
                )}
              </div>
              <div className="overflow-hidden rounded-lg border" style={{ borderColor: "rgb(var(--ink-rgb) / 0.07)" }}>
                {(primary.length > 0 ? primary : group.deliverables).map(renderRow)}
                {primary.length > 0 && supporting.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => toggleSupporting(group.sessionId)}
                      aria-expanded={supportingOpen}
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] text-ink/40 transition-colors hover:bg-ink/[0.02] hover:text-ink/60"
                    >
                      <ChevronDown className={`h-3 w-3 transition-transform ${supportingOpen ? "rotate-180" : ""}`} />
                      {supporting.length === 1
                        ? t("files.library.supportingOne")
                        : t("files.library.supporting", { count: supporting.length })}
                    </button>
                    {supportingOpen && supporting.map(renderRow)}
                  </>
                )}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}
