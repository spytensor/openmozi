import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";
import { formatRelativeTimeForLocale, useLocale } from "@/i18n";
import { useApi } from "@/hooks/useApi";

interface DeliverableVersion {
  id: string;
  deliverableId: string;
  version: number;
  size: number;
  createdAt: string;
}

interface DeliverableVersionHistoryProps {
  deliverableId: string;
  onRollback?: () => void;
  onOpenSession?: (sessionId: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Compact immutable version history shown in the Files artifact detail panel. */
export default function DeliverableVersionHistory({ deliverableId, onRollback, onOpenSession }: DeliverableVersionHistoryProps) {
  const { get, post } = useApi();
  const { t, locale } = useLocale();
  const [versions, setVersions] = useState<DeliverableVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: requestError } = await get<{ versions: DeliverableVersion[] }>(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/versions`,
    );
    setLoading(false);
    if (requestError || !data) {
      setError(requestError || t("files.versions.loadError"));
      return;
    }
    setVersions(Array.isArray(data.versions) ? data.versions : []);
  }, [deliverableId, get, t]);

  useEffect(() => { void load(); }, [load]);

  const rollback = async (version: number) => {
    if (!window.confirm(t("files.versions.rollbackConfirm", { version }))) return;
    setRollingBack(version);
    setError(null);
    const { error: requestError } = await post(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/rollback`,
      { version },
    );
    setRollingBack(null);
    if (requestError) {
      setError(requestError);
      return;
    }
    onRollback?.();
    await load();
  };

  const continueInNewSession = async () => {
    if (!onOpenSession) return;
    setContinuing(true);
    setError(null);
    const { data, error: requestError } = await post<{ session_id: string }>(
      `/api/deliverables/${encodeURIComponent(deliverableId)}/continue`,
      {},
    );
    setContinuing(false);
    if (requestError || !data?.session_id) {
      setError(requestError || t("files.continue.error"));
      return;
    }
    onOpenSession(data.session_id);
  };

  return (
    <section className="shrink-0 border-t border-ink/[0.06] bg-surface px-4 py-3" data-testid="deliverable-version-history">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[12px] font-medium text-ink/68">{t("files.versions.title")}</h2>
        {onOpenSession && (
          <button
            type="button"
            disabled={continuing}
            onClick={() => void continueInNewSession()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] text-link transition-colors hover:bg-ink/[0.04] disabled:cursor-not-allowed disabled:text-ink/25"
          >
            {continuing
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <MessageSquarePlus className="h-3.5 w-3.5" />}
            {t("files.continue")}
          </button>
        )}
      </div>
      {error && (
        <div className="mt-2 flex items-center gap-2 text-[11.5px] text-warning" role="alert">
          <span>{error}</span>
          <button type="button" className="underline underline-offset-2" onClick={() => void load()}>{t("common.retry")}</button>
        </div>
      )}
      {loading ? (
        <div className="mt-2 flex items-center gap-2 text-[11.5px] text-ink/38">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> {t("common.loading")}
        </div>
      ) : versions.length === 0 ? (
        <p className="mt-2 text-[11.5px] text-ink/38">{t("files.versions.empty")}</p>
      ) : (
        <ul className="mt-1 max-h-36 overflow-y-auto">
          {versions.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-3 border-b border-ink/[0.045] py-2 last:border-b-0">
              <span className="min-w-0">
                <span className="block text-[12px] font-medium text-ink/70">v{entry.version}</span>
                <span className="block truncate text-[10.5px] text-ink/36">
                  {formatRelativeTimeForLocale(entry.createdAt, locale)} · {formatSize(entry.size)}
                </span>
              </span>
              <button
                type="button"
                disabled={rollingBack !== null}
                onClick={() => void rollback(entry.version)}
                className="shrink-0 rounded-md px-2 py-1 text-[11.5px] text-link transition-colors hover:bg-ink/[0.04] disabled:cursor-not-allowed disabled:text-ink/25"
              >
                {rollingBack === entry.version ? t("files.versions.rollingBack") : t("files.versions.rollback")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
