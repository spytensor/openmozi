import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowLeft, ArrowRight, Plus, Search, Trash2 } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface TaskTemplate {
  id: string;
  title: string;
  instructions: string;
  output_format: string;
  pinned: boolean;
  sort_order: number;
}

interface TemplateResponse { template: TaskTemplate }
interface TemplatesResponse { templates: TaskTemplate[] }

interface TemplateDraft {
  title: string;
  instructions: string;
  output_format: string;
  pinned: boolean;
}

const EMPTY_DRAFT: TemplateDraft = { title: "", instructions: "", output_format: "", pinned: true };

export default function TaskTemplatesSurface({ onSelectPrompt }: { onSelectPrompt: (prompt: string) => void }) {
  const { t } = useLocale();
  const { get, post, put, del } = useApi();
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [editing, setEditing] = useState<TaskTemplate | null | "new">(null);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await get<TemplatesResponse>("/api/task-templates");
    setLoading(false);
    if (Array.isArray(result.data?.templates)) {
      setTemplates(result.data.templates);
      setError(null);
    } else {
      setError(result.error ?? t("common.unavailable"));
    }
  }, [get, t]);

  useEffect(() => { void load(); }, [load]);

  const filteredTemplates = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return query
      ? templates.filter(template => template.title.toLocaleLowerCase().includes(query))
      : templates;
  }, [search, templates]);

  const openLibrary = () => {
    setLibraryOpen(true);
    setEditing(null);
    setConfirmDeleteId(null);
  };

  const openEditor = (template?: TaskTemplate, initial?: Partial<TemplateDraft>) => {
    setLibraryOpen(true);
    setEditing(template ?? "new");
    setDraft(template ? {
      title: template.title,
      instructions: template.instructions,
      output_format: template.output_format,
      pinned: template.pinned,
    } : { ...EMPTY_DRAFT, ...initial });
    setConfirmDeleteId(null);
    setError(null);
  };

  const save = async () => {
    if (!draft.title.trim() || !draft.instructions.trim() || saving) return;
    setSaving(true);
    const body = {
      title: draft.title.trim(),
      instructions: draft.instructions.trim(),
      output_format: draft.output_format.trim(),
      pinned: draft.pinned,
    };
    const result = editing && editing !== "new"
      ? await put<TemplateResponse>(`/api/task-templates/${editing.id}`, body)
      : await post<TemplateResponse>("/api/task-templates", body);
    setSaving(false);
    if (!result.data) {
      setError(result.error ?? t("common.unavailable"));
      return;
    }
    await load();
    setEditing(null);
  };

  const remove = async (id: string) => {
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id);
      return;
    }
    const result = await del(`/api/task-templates/${id}`);
    if (result.error) {
      setError(result.error);
      return;
    }
    setConfirmDeleteId(null);
    await load();
  };

  const composePrompt = (template: TaskTemplate) => {
    const output = template.output_format.trim();
    return output
      ? `${template.instructions.trim()}\n\n${t("app.taskTemplates.outputPrefix")}\n${output}`
      : template.instructions.trim();
  };

  const chipClassName =
    "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[12.5px] text-ink/70 transition-colors hover:bg-ink/[0.03] hover:text-ink/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/35";
  const chipStyle = { borderColor: "var(--border-subtle)", background: "transparent" } as const;

  return (
    <>
      {loading && templates.length === 0 ? (
        <div className="mx-auto mt-4 flex max-w-[640px] justify-center" data-testid="task-templates-loading">
          <div className="h-9 w-44 animate-pulse rounded-lg bg-ink/[0.035]" />
        </div>
      ) : (
        <>
          {!error && templates.length === 0 && (
            <p className="mt-4 text-[12px] text-ink/42">{t("app.taskTemplates.empty")}</p>
          )}
          <div
            className="mx-auto mt-4 flex max-w-[640px] flex-wrap items-center justify-center gap-2 duration-180ms motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1"
            data-testid="task-template-row"
          >
            {templates.map(template => (
              <div key={template.id} className="group relative">
                <button
                  type="button"
                  data-testid="task-template-chip"
                  onClick={() => onSelectPrompt(composePrompt(template))}
                  className={chipClassName}
                  style={chipStyle}
                >
                  {template.title}
                  <ArrowDownRight className="h-3 w-3 text-ink/30 transition-colors group-hover:text-ink/55" aria-hidden="true" />
                </button>
                {/* Hover preview: the REAL prompt the chip fills — same contract
                    as the starter chips above. */}
                <div
                  data-testid="task-template-chip-preview"
                  className="pointer-events-none absolute left-1/2 top-[calc(100%+8px)] z-20 hidden w-[340px] -translate-x-1/2 rounded-lg border p-3 text-left text-[11.5px] leading-[1.6] text-ink/65 shadow-lg group-hover:block group-focus-within:block"
                  style={{ borderColor: "var(--border-subtle)", background: "var(--surface-elevated)" }}
                >
                  <p className="line-clamp-6 whitespace-pre-wrap">{composePrompt(template)}</p>
                </div>
              </div>
            ))}
            {templates.length === 0 && !error && (
              <>
                <button
                  type="button"
                  onClick={() => openEditor(undefined, { title: t("app.taskTemplates.example.email.title"), instructions: t("app.taskTemplates.example.email.instructions"), output_format: t("app.taskTemplates.example.email.output") })}
                  className={chipClassName}
                  style={chipStyle}
                >
                  {t("app.taskTemplates.example.email.title")}
                </button>
                <button
                  type="button"
                  onClick={() => openEditor(undefined, { title: t("app.taskTemplates.example.translate.title"), instructions: t("app.taskTemplates.example.translate.instructions"), output_format: t("app.taskTemplates.example.translate.output") })}
                  className={chipClassName}
                  style={chipStyle}
                >
                  {t("app.taskTemplates.example.translate.title")}
                </button>
              </>
            )}
            <button
              type="button"
              data-testid="task-template-new"
              onClick={() => openEditor()}
              className={chipClassName}
              style={chipStyle}
            >
              <Plus className="h-3.5 w-3.5 text-ink/45" aria-hidden="true" />
              {t("app.taskTemplates.create")}
            </button>
            {templates.length > 0 && (
              <button
                type="button"
                onClick={openLibrary}
                className="group inline-flex items-center gap-1 px-1.5 py-2 text-[12px] font-medium text-ink/42 transition-colors hover:text-ink/72 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-focus/40"
              >
                <span>{t("app.taskTemplates.manage")}</span>
                <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
              </button>
            )}
          </div>
        </>
      )}

      {error && !libraryOpen && (
        <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-warning" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => void load()} className="underline underline-offset-2">{t("common.retry")}</button>
        </div>
      )}

      <Dialog
        open={libraryOpen}
        onOpenChange={(open) => {
          setLibraryOpen(open);
          if (!open) {
            setEditing(null);
            setConfirmDeleteId(null);
            setSearch("");
          }
        }}
      >
        <DialogContent className="max-h-[min(700px,calc(100vh-32px))] max-w-[620px] overflow-hidden border-ink/[0.08] bg-elevated p-0 text-ink shadow-2xl">
          {editing ? (
            <TaskEditor
              title={editing === "new" ? t("app.taskTemplates.create") : t("app.taskTemplates.edit")}
              description={t("app.taskTemplates.description")}
              draft={draft}
              saving={saving}
              error={error}
              onBack={() => setEditing(null)}
              onDraftChange={setDraft}
              onSave={() => void save()}
            />
          ) : (
            <>
              <DialogHeader className="border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
                <div className="flex items-start justify-between gap-4 pr-7">
                  <div>
                    <DialogTitle className="text-[15px]">{t("app.taskTemplates.mine")}</DialogTitle>
                    <DialogDescription className="mt-1 text-[12px] text-ink/42">
                      {t("app.taskTemplates.libraryDescription")}
                    </DialogDescription>
                  </div>
                  <button
                    type="button"
                    onClick={() => openEditor()}
                    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-action px-3 text-[12px] font-medium text-action-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("app.taskTemplates.create")}
                  </button>
                </div>
              </DialogHeader>

              <div className="flex min-h-0 flex-col px-3 py-3">
                {templates.length > 0 && (
                  <label className="mx-1 mb-2 flex h-9 items-center gap-2 rounded-lg border px-3" style={{ borderColor: "var(--border-subtle)", background: "var(--surface-input)" }}>
                    <Search className="h-3.5 w-3.5 text-ink/32" />
                    <input
                      value={search}
                      onChange={event => setSearch(event.target.value)}
                      aria-label={t("app.taskTemplates.search")}
                      placeholder={t("app.taskTemplates.search")}
                      className="min-w-0 flex-1 bg-transparent text-[12px] text-ink/75 outline-none placeholder:text-ink/30"
                    />
                  </label>
                )}

                <div className="max-h-[420px] overflow-y-auto">
                  {loading && templates.length === 0 ? (
                    <div className="px-4 py-12 text-center text-[12px] text-ink/38">{t("app.connecting")}</div>
                  ) : filteredTemplates.length > 0 ? (
                    filteredTemplates.map(template => (
                      <div key={template.id} className="group relative flex min-h-11 items-center rounded-lg hover:bg-ink/[0.035] focus-within:bg-ink/[0.035]">
                        <button
                          type="button"
                          onClick={() => openEditor(template)}
                          aria-label={`${t("app.taskTemplates.edit")}: ${template.title}`}
                          className="min-w-0 flex-1 self-stretch truncate rounded-lg px-3 pr-12 text-left text-[12.5px] text-ink/76 outline-none focus-visible:ring-1 focus-visible:ring-focus/40"
                        >
                          {template.title}
                        </button>
                        <button
                          type="button"
                          onClick={() => void remove(template.id)}
                          aria-label={`${confirmDeleteId === template.id ? t("app.taskTemplates.confirmDelete") : t("app.taskTemplates.delete")}: ${template.title}`}
                          title={confirmDeleteId === template.id ? t("app.taskTemplates.confirmDelete") : t("app.taskTemplates.delete")}
                          className={confirmDeleteId === template.id
                            ? "absolute right-2 top-1/2 h-7 -translate-y-1/2 rounded-md bg-base px-2 text-[10.5px] font-medium text-danger shadow-sm"
                            : "absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-ink/30 opacity-0 transition-[opacity,color] hover:bg-base hover:text-danger focus:opacity-100 focus:text-danger group-hover:opacity-100 group-focus-within:opacity-100"}
                        >
                          {confirmDeleteId === template.id ? t("app.taskTemplates.confirmDelete") : <Trash2 className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    ))
                  ) : templates.length > 0 ? (
                    <div className="px-4 py-12 text-center text-[12px] text-ink/38">{t("app.taskTemplates.noMatches")}</div>
                  ) : (
                    <EmptyLibrary onCreate={openEditor} />
                  )}
                </div>

                {error && (
                  <div className="mt-2 flex items-center gap-2 px-2 text-[11px] text-warning" role="alert">
                    <span>{error}</span>
                    <button type="button" onClick={() => void load()} className="underline underline-offset-2">{t("common.retry")}</button>
                  </div>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskEditor({
  title,
  description,
  draft,
  saving,
  error,
  onBack,
  onDraftChange,
  onSave,
}: {
  title: string;
  description: string;
  draft: TemplateDraft;
  saving: boolean;
  error: string | null;
  onBack: () => void;
  onDraftChange: (draft: TemplateDraft) => void;
  onSave: () => void;
}) {
  const { t } = useLocale();
  return (
    <>
      <DialogHeader className="border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
        <div className="flex items-start gap-3 pr-7">
          <button type="button" onClick={onBack} aria-label={t("common.back")} className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/38 hover:bg-ink/[0.05] hover:text-ink/70">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <DialogTitle className="text-[15px]">{title}</DialogTitle>
            <DialogDescription className="mt-1 text-[12px] text-ink/42">{description}</DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <div className="space-y-4 overflow-y-auto px-5 py-4">
        <TemplateField label={t("app.taskTemplates.title")}>
          <input aria-label={t("app.taskTemplates.title")} value={draft.title} maxLength={80} onChange={event => onDraftChange({ ...draft, title: event.target.value })} className="h-9 w-full rounded-md border bg-transparent px-3 text-[13px] outline-none focus:border-focus/60" />
        </TemplateField>
        <TemplateField label={t("app.taskTemplates.instructions")} hint={t("app.taskTemplates.instructionsHint")}>
          <textarea aria-label={t("app.taskTemplates.instructions")} value={draft.instructions} maxLength={8000} rows={6} onChange={event => onDraftChange({ ...draft, instructions: event.target.value })} className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-[13px] leading-5 outline-none focus:border-focus/60" />
        </TemplateField>
        <TemplateField label={t("app.taskTemplates.outputFormat")} hint={t("app.taskTemplates.outputHint")}>
          <textarea aria-label={t("app.taskTemplates.outputFormat")} value={draft.output_format} maxLength={4000} rows={3} onChange={event => onDraftChange({ ...draft, output_format: event.target.value })} className="w-full resize-y rounded-md border bg-transparent px-3 py-2 text-[13px] leading-5 outline-none focus:border-focus/60" />
        </TemplateField>
        {error && <div className="text-[11px] text-warning" role="alert">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onBack} className="h-8 rounded-md px-3 text-[12px] text-ink/58 hover:bg-ink/[0.05]">{t("common.cancel")}</button>
          <button type="button" disabled={!draft.title.trim() || !draft.instructions.trim() || saving} onClick={onSave} className="h-8 rounded-md bg-action px-3 text-[12px] font-medium text-action-foreground disabled:opacity-40">{saving ? t("app.taskTemplates.saving") : t("app.taskTemplates.save")}</button>
        </div>
      </div>
    </>
  );
}

function EmptyLibrary({ onCreate }: { onCreate: (template?: TaskTemplate, initial?: Partial<TemplateDraft>) => void }) {
  const { t } = useLocale();
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-[12px] text-ink/40">{t("app.taskTemplates.empty")}</p>
      <div className="mt-3 flex flex-wrap justify-center gap-x-3 gap-y-1 text-[11px]">
        <button type="button" onClick={() => onCreate(undefined, { title: t("app.taskTemplates.example.email.title"), instructions: t("app.taskTemplates.example.email.instructions"), output_format: t("app.taskTemplates.example.email.output") })} className="text-ink/48 underline underline-offset-2 hover:text-ink/72">
          {t("app.taskTemplates.example.email.title")}
        </button>
        <button type="button" onClick={() => onCreate(undefined, { title: t("app.taskTemplates.example.translate.title"), instructions: t("app.taskTemplates.example.translate.instructions"), output_format: t("app.taskTemplates.example.translate.output") })} className="text-ink/48 underline underline-offset-2 hover:text-ink/72">
          {t("app.taskTemplates.example.translate.title")}
        </button>
      </div>
    </div>
  );
}

function TemplateField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium text-ink/72">{label}</span>
      {hint && <span className="mb-1.5 block text-[11px] text-ink/38">{hint}</span>}
      {children}
    </label>
  );
}
