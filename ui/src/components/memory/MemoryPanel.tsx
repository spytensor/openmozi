import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { useLocale, type MessageKey } from "@/i18n";

type MemoryCategory = "preference" | "fact" | "decision" | "lesson";

interface MemoryFact {
  id: number;
  chat_id: string;
  user_id: string | null;
  category: MemoryCategory;
  key: string;
  value: string;
  confidence: number;
  salience_score: number;
  source: string | null;
  status: "active" | "pending_review" | "disputed" | "retracted";
  origin_kind: "user" | "tool" | "assistant" | "manual" | "legacy";
  recall_count: number;
  created_at: string;
  updated_at: string;
}

interface MemoryFactsResponse {
  facts: Array<MemoryFact | { fact: MemoryFact; score: number }>;
}

function unwrapMemoryFacts(
  facts: MemoryFactsResponse["facts"] | null | undefined,
): MemoryFact[] {
  return (facts ?? []).flatMap((entry) => {
    const fact = "fact" in entry ? entry.fact : entry;
    return [{
      ...fact,
      chat_id: fact.chat_id ?? "",
      user_id: fact.user_id ?? null,
      status: fact.status ?? "active",
      origin_kind: fact.origin_kind ?? "legacy",
    }];
  });
}

interface SessionDigest {
  id: number;
  session_id: string;
  digest: string;
  topics: string[];
  open_threads: string[];
  message_count: number;
  created_at: string;
}

interface DigestsResponse {
  digests: SessionDigest[];
}

interface MemoryStatus {
  recall_strategy: string;
  search_mode: "local_fts" | "semantic_hybrid";
  semantic_enabled: boolean;
  semantic_available: boolean;
  embedding_provider: string | null;
  embedding_model: string | null;
  activation_threshold: number;
  fact_count: number;
  reason: string;
}

interface MemoryExport {
  exported_at: string;
  facts: MemoryFact[];
}

// Maps the backend `source` to a human label so users see where a memory came
// from. Unknown/legacy sources render no chip rather than a cryptic token.
const SOURCE_LABEL: Record<string, MessageKey> = {
  auto_extract: "memory.source_learned",
  manual: "memory.source_manual",
  user_edit: "memory.source_edited",
  consolidation: "memory.source_consolidated",
  auto_extract_correction: "memory.source_correction",
  correction: "memory.source_correction",
  project_user_assertion: "memory.source_project_user",
  project_user_correction: "memory.source_project_user",
  project_extraction: "memory.source_project_legacy",
};

const STATUS_LABEL: Record<MemoryFact["status"], MessageKey> = {
  active: "memory.status_active",
  pending_review: "memory.status_pending_review",
  disputed: "memory.status_disputed",
  retracted: "memory.status_retracted",
};

// Fixed display order so the browser always reads the same top-to-bottom.
const CATEGORY_ORDER: MemoryCategory[] = ["preference", "fact", "decision", "lesson"];

const CATEGORY_LABEL: Record<MemoryCategory, MessageKey> = {
  preference: "memory.category_preference",
  fact: "memory.category_fact",
  decision: "memory.category_decision",
  lesson: "memory.category_lesson",
};

function formatDateTime(value: string | null | undefined, locale: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

/** Map salience (0..1) to a 3-level strength so users see how firmly a memory is held. */
function strengthLevel(salience: number): 1 | 2 | 3 {
  if (salience >= 0.7) return 3;
  if (salience >= 0.4) return 2;
  return 1;
}

function StrengthMeter({ salience, label, hint }: { salience: number; label: string; hint: string }) {
  const level = strengthLevel(salience);
  return (
    <span className="inline-flex items-center gap-1" title={`${label} — ${hint}`}>
      <span className="flex items-end gap-0.5" aria-hidden="true">
        {[1, 2, 3].map((bar) => (
          <span
            key={bar}
            className={bar <= level ? "w-0.5 rounded-full bg-activity/60" : "w-0.5 rounded-full bg-ink/15"}
            style={{ height: `${3 + bar * 2}px` }}
          />
        ))}
      </span>
      <span>{label}</span>
    </span>
  );
}

export default function MemoryPanel() {
  const { get, post, patch, del } = useApi();
  const { locale, t } = useLocale();
  const [search, setSearch] = useState("");
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [digests, setDigests] = useState<SessionDigest[]>([]);
  const [loadingFacts, setLoadingFacts] = useState(true);
  const [loadingDigests, setLoadingDigests] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [digestsError, setDigestsError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [clearing, setClearing] = useState(false);
  const [reviewingId, setReviewingId] = useState<number | null>(null);

  // Inline edit
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  // Manual add
  const [adding, setAdding] = useState(false);
  const [addCategory, setAddCategory] = useState<MemoryCategory>("preference");
  const [addValue, setAddValue] = useState("");
  const [savingAdd, setSavingAdd] = useState(false);

  const factsEndpoint = useMemo(() => {
    const query = search.trim();
    return query
      ? `/api/memory/search?q=${encodeURIComponent(query)}&limit=50`
      : "/api/memory/facts";
  }, [search]);

  const loadFacts = useCallback(async () => {
    setLoadingFacts(true);
    setError(null);
    const { data, error: err } = await get<MemoryFactsResponse>(factsEndpoint);
    if (err || !data) {
      setFacts([]);
      setError(err || t("memory.error"));
    } else {
      setFacts(unwrapMemoryFacts(data.facts));
    }
    setLoadingFacts(false);
  }, [factsEndpoint, get, t]);

  const loadDigests = useCallback(async () => {
    setLoadingDigests(true);
    setDigestsError(null);
    const { data, error: err } = await get<DigestsResponse>("/api/memory/digests");
    if (err || !data) {
      setDigests([]);
      setDigestsError(err || t("memory.sessions_error"));
    } else {
      setDigests(data.digests ?? []);
    }
    setLoadingDigests(false);
  }, [get, t]);

  const loadStatus = useCallback(async () => {
    const { data } = await get<MemoryStatus>("/api/memory/status");
    if (data) setStatus(data);
  }, [get]);

  useEffect(() => {
    void loadFacts();
  }, [loadFacts]);

  useEffect(() => {
    void loadDigests();
  }, [loadDigests]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const refresh = () => {
    void loadFacts();
    void loadDigests();
    void loadStatus();
  };

  const exportMemory = async () => {
    const { data, error: err } = await get<MemoryExport>("/api/memory/export");
    if (err || !data) {
      setError(err || t("memory.error"));
      return;
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "mozi-memory.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const clearAll = async () => {
    if (!window.confirm(t("memory.clear_all_confirm"))) return;
    setClearing(true);
    const { error: err } = await del("/api/memory/facts");
    setClearing(false);
    if (err) {
      setError(t("memory.clear_error", { error: err }));
      return;
    }
    void loadFacts();
  };

  const grouped = useMemo(() => {
    const map = new Map<MemoryCategory, MemoryFact[]>();
    for (const fact of facts) {
      const bucket = map.get(fact.category) ?? [];
      bucket.push(fact);
      map.set(fact.category, bucket);
    }
    return CATEGORY_ORDER
      .map((category) => ({ category, items: map.get(category) ?? [] }))
      .filter((group) => group.items.length > 0);
  }, [facts]);

  const beginEdit = (fact: MemoryFact) => {
    setEditingId(fact.id);
    setEditValue(fact.value);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const saveEdit = async (fact: MemoryFact) => {
    const value = editValue.trim();
    if (!value || value === fact.value) {
      cancelEdit();
      return;
    }
    setSavingEdit(true);
    const { error: err } = await patch(`/api/memory/facts/${fact.id}`, { value });
    setSavingEdit(false);
    if (err) {
      setError(t("memory.edit_error", { error: err }));
      return;
    }
    cancelEdit();
    void loadFacts();
  };

  const deleteFact = async (fact: MemoryFact) => {
    if (!window.confirm(t("memory.delete_confirm", { key: fact.key }))) return;
    setDeletingId(fact.id);
    setError(null);
    const { error: err } = await del(`/api/memory/facts/${fact.id}`);
    setDeletingId(null);
    if (err) {
      setError(err);
      return;
    }
    void loadFacts();
  };

  const confirmFact = async (fact: MemoryFact) => {
    setReviewingId(fact.id);
    setError(null);
    const { error: err } = await patch(`/api/memory/facts/${fact.id}/status`, { status: "active" });
    setReviewingId(null);
    if (err) {
      setError(t("memory.review_error", { error: err }));
      return;
    }
    void loadFacts();
  };

  const saveAdd = async () => {
    const value = addValue.trim();
    if (!value) return;
    setSavingAdd(true);
    const { error: err } = await post("/api/memory/facts", { category: addCategory, value });
    setSavingAdd(false);
    if (err) {
      setError(t("memory.add_error", { error: err }));
      return;
    }
    setAddValue("");
    setAdding(false);
    void loadFacts();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-ink/40">
        <span className="inline-flex items-center gap-1.5">
          <Brain className="h-3.5 w-3.5 text-activity/60" />
          {t("memory.local_only")}
        </span>
        {status && (
          status.semantic_enabled ? (
            <span className="inline-flex items-center gap-1.5 text-ink/45" title={t("memory.recall_semantic", { model: status.embedding_model ?? status.embedding_provider ?? "" })}>
              <Sparkles className="h-3.5 w-3.5 text-activity/70" />
              {t("memory.recall_semantic", { model: status.embedding_model ?? status.embedding_provider ?? "" })}
            </span>
          ) : (
            <span
              className="inline-flex items-center gap-1.5 text-ink/38"
              title={status.semantic_available
                ? t("memory.recall_local_threshold_hint", { threshold: status.activation_threshold })
                : t("memory.recall_local_hint")}
            >
              <Sparkles className="h-3.5 w-3.5 text-ink/25" />
              {t("memory.recall_local", { count: status.fact_count })}
            </span>
          )
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label
          className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-md border px-2.5"
          style={{ borderColor: "var(--border-medium)", background: "var(--surface-input)" }}
        >
          <Search className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("memory.search_placeholder")}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-ink/30"
            style={{ color: "var(--text-primary)" }}
          />
          {search && (
            <button type="button" onClick={() => setSearch("")} title={t("memory.clear_search")}>
              <X className="h-3.5 w-3.5" style={{ color: "var(--text-muted)" }} />
            </button>
          )}
        </label>
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors hover:bg-ink/[0.04]"
          style={{ borderColor: "var(--border-medium)", color: "var(--text-secondary)" }}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("memory.add")}
        </button>
        <button
          type="button"
          onClick={() => void exportMemory()}
          title={t("memory.export")}
          disabled={facts.length === 0}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-ink/[0.04] disabled:opacity-40"
          style={{ borderColor: "var(--border-medium)", color: "var(--text-secondary)" }}
        >
          <Download className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => void clearAll()}
          title={t("memory.clear_all")}
          disabled={facts.length === 0 || clearing}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border text-ink/45 transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:opacity-40"
          style={{ borderColor: "var(--border-medium)" }}
        >
          {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={refresh}
          title={t("common.refresh")}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-ink/[0.04]"
          style={{ borderColor: "var(--border-medium)", color: "var(--text-secondary)" }}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {adding && (
        <div className="flex flex-col gap-2 rounded-lg border p-3" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-input)" }}>
          <div className="flex items-center gap-2">
            <span className="text-[11.5px] font-medium text-ink/50">{t("memory.add_type")}</span>
            <select
              value={addCategory}
              onChange={(event) => setAddCategory(event.target.value as MemoryCategory)}
              className="rounded-md border px-2 py-1 text-[12.5px] outline-none"
              style={{ background: "var(--surface-elevated)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
            >
              {CATEGORY_ORDER.map((category) => (
                <option key={category} value={category}>{t(CATEGORY_LABEL[category])}</option>
              ))}
            </select>
          </div>
          <textarea
            value={addValue}
            onChange={(event) => setAddValue(event.target.value)}
            placeholder={t("memory.add_value_placeholder")}
            rows={2}
            className="w-full resize-y rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-ink/30"
            style={{ background: "var(--surface-elevated)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
          />
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { setAdding(false); setAddValue(""); }}
              className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-ink/55 hover:bg-ink/[0.05]"
            >
              {t("memory.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void saveAdd()}
              disabled={!addValue.trim() || savingAdd}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-action px-3 text-[12px] font-medium text-action-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {savingAdd ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {savingAdd ? t("memory.saving") : t("memory.save")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-[12px] text-warning">
          <span className="min-w-0 break-words">{t("memory.error_with_detail", { error })}</span>
          <button
            type="button"
            onClick={() => void loadFacts()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-warning/30 px-2 py-1 font-medium hover:bg-warning/10"
          >
            <RefreshCw className="h-3 w-3" />
            {t("common.retry")}
          </button>
        </div>
      )}

      {loadingFacts ? (
        <div className="flex items-center justify-center gap-2 rounded-lg border px-4 py-10 text-[12.5px] text-ink/40" style={{ borderColor: "var(--border-subtle)" }}>
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("common.loading")}
        </div>
      ) : error ? null : facts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border px-4 py-14 text-center text-[12.5px] text-ink/35" style={{ borderColor: "var(--border-subtle)" }}>
          <Brain className="h-5 w-5 text-ink/25" />
          <span>{t("memory.empty")}</span>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map((group) => (
            <section key={group.category}>
              <div className="mb-1.5 flex items-center gap-2 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink/40">
                <span>{t(CATEGORY_LABEL[group.category])}</span>
                <span className="text-ink/28">{group.items.length}</span>
              </div>
              <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}>
                {group.items.map((fact) => (
                  <article
                    key={fact.id}
                    className={fact.status === "pending_review" ? "border-b bg-warning/[0.04] px-3 py-2.5 last:border-b-0" : "border-b px-3 py-2.5 last:border-b-0"}
                    style={{ borderColor: "var(--border-subtle)" }}
                  >
                    {editingId === fact.id ? (
                      <div className="flex flex-col gap-2">
                        <textarea
                          value={editValue}
                          onChange={(event) => setEditValue(event.target.value)}
                          rows={2}
                          autoFocus
                          className="w-full resize-y rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none"
                          style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                        />
                        <div className="flex items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={cancelEdit}
                            className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-ink/55 hover:bg-ink/[0.05]"
                          >
                            {t("memory.cancel")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void saveEdit(fact)}
                            disabled={savingEdit}
                            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-action px-3 text-[12px] font-medium text-action-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {savingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                            {savingEdit ? t("memory.saving") : t("memory.save")}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="group/fact flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="overflow-wrap-anywhere text-[13px] leading-5 text-ink/82">{fact.value}</p>
                          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink/36">
                            <span className="rounded-full border px-1.5 py-0.5 text-[10px] text-ink/45" style={{ borderColor: "var(--border-subtle)" }}>
                              {t(fact.chat_id.startsWith("__project__") ? "memory.scope_project" : "memory.scope_personal")}
                            </span>
                            {fact.status !== "active" && (
                              <span className="rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[10px] text-warning">
                                {t(STATUS_LABEL[fact.status])}
                              </span>
                            )}
                            {fact.source && SOURCE_LABEL[fact.source] && (
                              <span className="rounded-full border px-1.5 py-0.5 text-[10px] text-ink/45" style={{ borderColor: "var(--border-subtle)" }}>
                                {t(SOURCE_LABEL[fact.source])}
                              </span>
                            )}
                            <span>{t("memory.learned", { time: formatDateTime(fact.created_at, locale) })}</span>
                            <span>{t("memory.recalled", { count: fact.recall_count })}</span>
                            <StrengthMeter
                              salience={fact.salience_score}
                              hint={t("memory.strength_hint")}
                              label={t(
                                strengthLevel(fact.salience_score) === 3
                                  ? "memory.strength_strong"
                                  : strengthLevel(fact.salience_score) === 2
                                    ? "memory.strength_medium"
                                    : "memory.strength_weak",
                              )}
                            />
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/fact:opacity-100 focus-within:opacity-100">
                          {fact.status === "pending_review" && (
                            <button
                              type="button"
                              onClick={() => void confirmFact(fact)}
                              disabled={reviewingId === fact.id}
                              title={t("memory.confirm_project_fact")}
                              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] font-medium text-warning transition-colors hover:bg-warning/10 disabled:opacity-50"
                            >
                              {reviewingId === fact.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              {t("memory.confirm")}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => beginEdit(fact)}
                            title={t("memory.edit")}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.06] hover:text-ink/75"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteFact(fact)}
                            disabled={deletingId === fact.id}
                            title={t("memory.delete")}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                          >
                            {deletingId === fact.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}>
        <button
          type="button"
          onClick={() => setSessionsOpen((open) => !open)}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-[13px] font-medium text-ink/78 transition-colors hover:bg-ink/[0.03]"
        >
          {sessionsOpen ? <ChevronDown className="h-4 w-4 text-ink/40" /> : <ChevronRight className="h-4 w-4 text-ink/40" />}
          <span className="min-w-0 flex-1">{t("memory.sessions_section")}</span>
          {digests.length > 0 && <span className="text-[11px] text-ink/30">{digests.length}</span>}
        </button>
        {sessionsOpen && (
          <div className="border-t" style={{ borderColor: "var(--border-subtle)" }}>
            {loadingDigests ? (
              <div className="flex items-center justify-center gap-2 px-4 py-8 text-[12.5px] text-ink/40">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : digestsError ? (
              <div className="px-3 py-3 text-[12px] text-warning">{digestsError}</div>
            ) : digests.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12.5px] text-ink/35">{t("memory.no_sessions")}</div>
            ) : (
              digests.map((digest) => (
                <article key={digest.id} className="border-b px-3 py-3 last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                  <p className="overflow-wrap-anywhere text-[12.5px] leading-5 text-ink/72">{digest.digest}</p>
                  {digest.open_threads.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-ink/34">{t("memory.open_threads")}</p>
                      <ul className="flex flex-col gap-0.5">
                        {digest.open_threads.map((thread, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-[12px] text-ink/55">
                            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-activity/50" />
                            <span className="overflow-wrap-anywhere">{thread}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 text-[11px] text-ink/36">
                    <span>{formatDateTime(digest.created_at, locale)}</span>
                    <span>{t("memory.session_messages", { count: digest.message_count })}</span>
                  </div>
                </article>
              ))
            )}
          </div>
        )}
      </section>
    </div>
  );
}
