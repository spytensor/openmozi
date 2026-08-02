import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bot,
  ChevronDown,
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { ModelPickerMenu } from "@/components/models/ModelPickerMenu";
import { useApi } from "@/hooks/useApi";
import { useModelState } from "@/hooks/useModelState";
import { useLocale, type MessageKey } from "@/i18n";
import type { AgentDetail, AgentInfo, SkillInfo } from "@/types/management";
import type { CatalogModel, CatalogProvider } from "@/lib/model-catalog";
import { AGENT_COLOR_IDS, agentAvatarColor, agentAvatarStyle, agentSwatchStyle } from "@/lib/agent-colors";
import { AGENT_ICON_IDS, agentIcon } from "@/lib/agent-icons";

type StatusFilter = "all" | AgentInfo["status"];
type PermissionLevel = NonNullable<AgentDetail["permission_level"]>;

interface AgentForm {
  name: string;
  description: string;
  persona: string;
  model: string;
  skills: string[];
  tools: string[];
  permission_level: PermissionLevel;
  color: string;
  icon: string;
}

const EMPTY_FORM: AgentForm = {
  name: "",
  description: "",
  persona: "",
  model: "",
  skills: [],
  tools: [],
  permission_level: "L0_READ_ONLY",
  color: "ochre",
  icon: "bot",
};

const COLORS = AGENT_COLOR_IDS.map(id => ({ id, value: agentAvatarColor(id) }));

// Mirrors TOOL_GROUPS in src/agents/delegate-runner.ts — the groups the isolated
// run actually understands. Leaving the selection empty inherits the default
// (filesystem + shell), which is what an AGENT.md without a `tools:` key gets.
const TOOL_GROUPS = [
  { id: "filesystem", labelKey: "agents.tool.files", hintKey: "agents.tool.filesHint" },
  { id: "shell", labelKey: "agents.tool.shell", hintKey: "agents.tool.shellHint" },
  { id: "git", labelKey: "agents.tool.git", hintKey: "agents.tool.gitHint" },
  { id: "network", labelKey: "agents.tool.web", hintKey: "agents.tool.webHint" },
] as const;
const DEFAULT_TOOL_GROUPS = ["filesystem", "shell"];

function modelParts(value: string): { provider: string; model: string } {
  const separator = value.indexOf("/");
  return separator > 0
    ? { provider: value.slice(0, separator), model: value.slice(separator + 1) }
    : { provider: "", model: value };
}

function formFromDetail(detail: AgentDetail): AgentForm {
  return {
    name: detail.name,
    description: detail.description,
    persona: detail.persona,
    model: detail.model ?? "",
    skills: detail.skills,
    tools: detail.tools ?? [],
    permission_level: detail.permission_level ?? "L0_READ_ONLY",
    color: detail.color ?? "ochre",
    icon: detail.icon ?? "bot",
  };
}

function statusLabel(
  status: AgentInfo["status"],
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  if (status === "ready") return t("agents.status.ready");
  if (status === "needs-setup") return t("agents.status.needsSetup");
  return t("agents.status.disabled");
}

export default function AgentsView() {
  const { get, post, put, del } = useApi();
  const { t } = useLocale();
  const modelState = useModelState();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [drawer, setDrawer] = useState<"create" | string | null>(null);
  const [detail, setDetail] = useState<AgentDetail | null>(null);
  const [form, setForm] = useState<AgentForm>(EMPTY_FORM);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  const loadAgents = async () => {
    setLoading(true);
    const [{ data, error: agentsError }, { data: skillData }] = await Promise.all([
      get<{ agents: AgentInfo[] }>("/api/agents"),
      get<{ skills: SkillInfo[] }>("/api/skills"),
    ]);
    setAgents(data?.agents ?? []);
    setSkills(skillData?.skills ?? []);
    setError(agentsError);
    setLoading(false);
  };

  useEffect(() => {
    void loadAgents();
  }, []);

  useEffect(() => {
    if (!drawer || drawer === "create") return;
    let cancelled = false;
    setDrawerLoading(true);
    setMutationError(null);
    get<{ agent: AgentDetail }>(`/api/agents/${encodeURIComponent(drawer)}`).then(({ data, error }) => {
      if (cancelled) return;
      setDrawerLoading(false);
      if (error || !data?.agent) {
        setMutationError(error ?? t("agents.error.notFound"));
        return;
      }
      setDetail(data.agent);
      setForm(formFromDetail(data.agent));
    });
    return () => {
      cancelled = true;
    };
  }, [drawer, get, t]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return agents.filter(agent => {
      if (filter !== "all" && agent.status !== filter) return false;
      return !normalized || [agent.name, agent.description, agent.model ?? "", ...agent.skills]
        .some(value => value.toLowerCase().includes(normalized));
    });
  }, [agents, filter, query]);

  const openCreate = () => {
    setDetail(null);
    setForm(EMPTY_FORM);
    setMutationError(null);
    setDrawer("create");
  };

  const openAgent = (agent: AgentInfo) => {
    setDetail(null);
    setForm(EMPTY_FORM);
    setMutationError(null);
    setDrawer(agent.id);
  };

  const closeDrawer = () => {
    setDrawer(null);
    setDetail(null);
    setMutationError(null);
  };

  const save = async () => {
    setSaving(true);
    setMutationError(null);
    const payload = {
      ...form,
      model: form.model || undefined,
      skills: form.skills,
      tools: form.tools.length > 0 ? form.tools : undefined,
    };
    const result = drawer === "create"
      ? await post<{ agent: AgentDetail }>("/api/agents", payload)
      : await put<{ agent: AgentDetail }>(`/api/agents/${encodeURIComponent(drawer ?? "")}`, payload);
    setSaving(false);
    if (result.error) {
      setMutationError(result.error);
      return;
    }
    closeDrawer();
    await loadAgents();
  };

  const toggleState = async (agent: AgentInfo) => {
    const result = await post(`/api/agents/${encodeURIComponent(agent.id)}/state`, { enabled: !agent.enabled });
    if (result.error) setError(result.error);
    else await loadAgents();
  };

  const remove = async (agent: AgentInfo) => {
    if (!window.confirm(t("agents.delete.confirm", { name: agent.name }))) return;
    const result = await del(`/api/agents/${encodeURIComponent(agent.id)}`);
    if (result.error) setError(result.error);
    else await loadAgents();
  };

  return (
    <WorkspacePage testId="agents-view" contentClassName="mx-auto max-w-[1180px]">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold text-ink/90">{t("agents.title")}</h1>
          <p className="mt-1 text-[13px] text-ink/45">{t("agents.description")}</p>
        </div>
        <button type="button" onClick={openCreate} className="btn-primary h-8 whitespace-nowrap px-3 text-[12px]">
          <Plus className="h-3.5 w-3.5" />
          {t("agents.create")}
        </button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex h-8 min-w-[220px] flex-1 items-center gap-2 rounded-md border border-ink/10 bg-input px-2.5">
          <Search className="h-3.5 w-3.5 text-ink/35" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("agents.search")}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-ink/75 outline-none placeholder:text-ink/30"
          />
        </label>
        {(["all", "ready", "needs-setup", "disabled"] as const).map(value => (
          <button
            key={value}
            type="button"
            onClick={() => setFilter(value)}
            className="h-8 rounded-md border px-2.5 text-[11.5px] transition-colors"
            style={{
              borderColor: filter === value ? "var(--border-medium)" : "var(--border-subtle)",
              background: filter === value ? "var(--surface-active)" : "transparent",
              color: filter === value ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            {value === "all" ? t("agents.filter.all") : statusLabel(value, t)}
          </button>
        ))}
      </div>

      {error && <p className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
      {loading ? (
        <p className="flex items-center gap-2 py-8 text-[13px] text-ink/45">
          <Loader2 className="h-4 w-4 animate-spin" /> {t("agents.loading")}
        </p>
      ) : visible.length === 0 ? (
        <p className="py-4 text-[13px] text-ink/40">{t("agents.empty")}</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visible.map(agent => (
            <article
              key={agent.id}
              className="flex min-w-0 cursor-pointer items-start gap-3 rounded-lg border border-ink/[0.08] bg-elevated p-4 transition-colors hover:bg-ink/[0.035]"
              onClick={() => openAgent(agent)}
            >
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center"
                style={agentAvatarStyle(agent.color)}
              >
                {(() => {
                  const Glyph = agentIcon(agent.icon, agent.name);
                  return <Glyph className="h-5 w-5" strokeWidth={1.75} />;
                })()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-[14px] font-semibold text-ink/82">{agent.name}</h2>
                  <span className="rounded border border-ink/[0.08] px-1.5 py-0.5 text-[10px] text-ink/45">
                    {statusLabel(agent.status, t)}
                  </span>
                  {agent.source === "workspace" && (
                    <span className="rounded border border-ink/[0.08] px-1.5 py-0.5 text-[10px] text-ink/35">{t("agents.source.workspace")}</span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-[12px] leading-5 text-ink/48">{agent.description}</p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {agent.skills.map(skill => (
                    <span key={skill} className="rounded border border-ink/[0.06] bg-ink/[0.025] px-1.5 py-0.5 text-[10px] text-ink/45">
                      {skill}
                    </span>
                  ))}
                  <span className="text-[10.5px] text-ink/35">{agent.model || t("agents.model.followsGlobal")}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1" onClick={event => event.stopPropagation()}>
                {agent.source === "workspace" && (
                  <button
                    type="button"
                    onClick={() => void toggleState(agent)}
                    className="h-7 rounded-md px-2 text-[10.5px] text-ink/45 hover:bg-ink/[0.06] hover:text-ink/70"
                  >
                    {agent.enabled ? t("agents.disable") : t("agents.enable")}
                  </button>
                )}
                {agent.source === "workspace" && (
                  <button
                    type="button"
                    aria-label={t("agents.delete.label", { name: agent.name })}
                    onClick={() => void remove(agent)}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-ink/35 hover:bg-danger/10 hover:text-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}

      {drawer && (
        <AgentDrawer
          mode={drawer === "create" ? "create" : "edit"}
          detail={detail}
          form={form}
          skills={skills}
          providers={modelState.data?.providers ?? []}
          loading={drawerLoading}
          saving={saving}
          error={mutationError}
          onChange={setForm}
          onClose={closeDrawer}
          onSave={() => void save()}
        />
      )}
    </WorkspacePage>
  );
}

function AgentDrawer({
  mode,
  detail,
  form,
  skills,
  providers,
  loading,
  saving,
  error,
  onChange,
  onClose,
  onSave,
}: {
  mode: "create" | "edit";
  detail: AgentDetail | null;
  form: AgentForm;
  skills: SkillInfo[];
  providers: CatalogProvider[];
  loading: boolean;
  saving: boolean;
  error: string | null;
  onChange: (value: AgentForm) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  const { t } = useLocale();
  // Editing a bundled preset is allowed: saving forks it into the workspace,
  // where a definition of the same name shadows the bundled one. Nothing in the
  // install tree is written.
  const forksOnSave = detail?.source === "bundled";
  const readOnly = false;
  const selected = modelParts(form.model);
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]) => onChange({ ...form, [key]: value });
  const selectModel = (provider: CatalogProvider, model: CatalogModel) => set("model", `${provider.id}/${model.id}`);
  const canSave = form.name.trim() && form.description.trim() && !saving
    && !loading && (mode === "create" || detail !== null);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/35" role="dialog" aria-modal="true">
      <div className="flex h-full w-full max-w-[720px] flex-col overflow-hidden border-l border-ink/10 bg-surface">
        <header className="flex items-start justify-between gap-3 border-b border-ink/10 px-5 py-4">
          <div>
            <h2 className="text-[18px] font-semibold text-ink/85">
              {mode === "create" ? t("agents.create") : detail?.name ?? t("agents.details")}
            </h2>
            <p className="mt-1 text-[12px] text-ink/42">
              {forksOnSave
                ? t("agents.bundledForkHint")
                : t("agents.savedPathHint")}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label={t("agents.close")} className="flex h-8 w-8 items-center justify-center rounded-md text-ink/45 hover:bg-ink/[0.06]">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <p className="flex items-center gap-2 py-10 text-[13px] text-ink/45"><Loader2 className="h-4 w-4 animate-spin" /> {t("agents.loadingOne")}</p>
          ) : (
            <div className="space-y-4">
              {error && <p className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">{error}</p>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <Field label={t("agents.field.name")}>
                  <input
                    value={form.name}
                    disabled={readOnly}
                    onChange={event => set("name", event.target.value)}
                    placeholder="research-analyst"
                    className="h-9 w-full rounded-md border border-ink/10 bg-input px-3 text-[12px] text-ink/75 outline-none focus:border-focus/50 disabled:opacity-60"
                  />
                </Field>
                <Field label={t("agents.field.permission")}>
                  <select
                    value={form.permission_level}
                    disabled={readOnly}
                    onChange={event => set("permission_level", event.target.value as PermissionLevel)}
                    className="h-9 w-full rounded-md border border-ink/10 bg-input px-3 text-[12px] text-ink/75 outline-none focus:border-focus/50 disabled:opacity-60"
                  >
                    <option value="L0_READ_ONLY">{t("agents.permission.readOnly")}</option>
                    <option value="L1_READ_WRITE">{t("agents.permission.readWrite")}</option>
                    <option value="L2_SHELL_EXEC">{t("agents.permission.shell")}</option>
                    <option value="L3_FULL_ACCESS">{t("agents.permission.full")}</option>
                  </select>
                </Field>
              </div>

              <Field label={t("agents.field.description")}>
                <input
                  value={form.description}
                  disabled={readOnly}
                  onChange={event => set("description", event.target.value)}
                  placeholder={t("agents.descriptionPlaceholder")}
                  className="h-9 w-full rounded-md border border-ink/10 bg-input px-3 text-[12px] text-ink/75 outline-none focus:border-focus/50 disabled:opacity-60"
                />
              </Field>

              <Field label={t("agents.field.model")}>
                <div className="flex gap-2">
                  <ModelPickerMenu
                    providers={providers}
                    selectedProvider={selected.provider}
                    selectedModel={selected.model}
                    disabled={readOnly}
                    side="bottom"
                    align="start"
                    trigger={(
                      <button type="button" className="flex h-9 flex-1 items-center justify-between rounded-md border border-ink/10 bg-input px-3 text-left text-[12px] text-ink/75">
                        <span className="truncate">{form.model || t("agents.model.followGlobal")}</span>
                        <ChevronDown className="h-3.5 w-3.5 text-ink/35" />
                      </button>
                    )}
                    onSelect={selectModel}
                  />
                  {form.model && !readOnly && (
                    <button type="button" onClick={() => set("model", "")} className="rounded-md border border-ink/10 px-2.5 text-[11px] text-ink/45 hover:bg-ink/[0.05]">
                      {t("agents.model.inherit")}
                    </button>
                  )}
                </div>
              </Field>

              <Field label={t("agents.field.skills")}>
                {skills.length === 0 ? (
                  <p className="text-[12px] text-ink/40">{t("agents.skills.empty")}</p>
                ) : (
                  <div className="flex max-h-[150px] flex-wrap content-start gap-2 overflow-y-auto">
                    {skills.map(skill => {
                      const checked = form.skills.includes(skill.name);
                      return (
                        <label key={skill.name} className="flex cursor-pointer items-center gap-2 rounded-md border border-ink/[0.08] px-2 py-1.5 text-[11.5px] text-ink/55">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={readOnly}
                            onChange={() => set("skills", checked
                              ? form.skills.filter(name => name !== skill.name)
                              : [...form.skills, skill.name])}
                            className="h-3.5 w-3.5 accent-[var(--action)]"
                          />
                          {skill.name}
                        </label>
                      );
                    })}
                  </div>
                )}
              </Field>

              <Field label={t("agents.field.tools")}>
                <div className="flex flex-wrap gap-2">
                  {TOOL_GROUPS.map(group => {
                    const checked = form.tools.includes(group.id);
                    return (
                      <label
                        key={group.id}
                        title={t(group.hintKey)}
                        className="flex cursor-pointer items-center gap-2 rounded-md border border-ink/[0.08] px-2 py-1.5 text-[11.5px] text-ink/55"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={readOnly}
                          onChange={() => set("tools", checked
                            ? form.tools.filter(name => name !== group.id)
                            : [...form.tools, group.id])}
                          className="h-3.5 w-3.5 accent-[var(--action)]"
                        />
                        {t(group.labelKey)}
                      </label>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-ink/35">
                  {form.tools.length === 0
                    ? t("agents.tools.default", { tools: DEFAULT_TOOL_GROUPS.join(" + ") })
                    : t("agents.tools.noRedelegation")}
                </p>
              </Field>

              <Field label={t("agents.field.color")}>
                <div className="flex items-center gap-2">
                  {COLORS.map(color => (
                    <button
                      key={color.id}
                      type="button"
                      disabled={readOnly}
                      onClick={() => set("color", color.id)}
                      aria-label={color.id}
                      className="h-7 w-7 rounded-md border"
                      style={{
                        background: color.value,
                        borderColor: form.color === color.id ? "var(--text-primary)" : "var(--border-subtle)",
                      }}
                    />
                  ))}
                </div>
              </Field>

              <Field label={t("agents.field.icon")}>
                <div className="flex flex-wrap gap-1.5">
                  {AGENT_ICON_IDS.map(id => {
                    const Glyph = agentIcon(id, id);
                    const selected = form.icon === id;
                    return (
                      <button
                        key={id}
                        type="button"
                        disabled={readOnly}
                        onClick={() => set("icon", id)}
                        aria-label={id}
                        aria-pressed={selected}
                        title={id}
                        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors"
                        style={
                          selected
                            ? agentSwatchStyle(form.color)
                            : { color: "var(--text-muted)", background: "transparent" }
                        }
                      >
                        <Glyph className="h-4 w-4" strokeWidth={1.75} />
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-[11px] text-ink/35">
                  {t("agents.icon.hint")}
                </p>
              </Field>

              <Field label={t("agents.field.persona")}>
                <textarea
                  value={form.persona}
                  disabled={readOnly}
                  onChange={event => set("persona", event.target.value)}
                  placeholder={t("agents.personaPlaceholder")}
                  className="h-[260px] w-full resize-y rounded-md border border-ink/10 bg-[var(--code-bg)] px-3 py-2 font-mono text-[12px] leading-5 text-ink/72 outline-none focus:border-focus/50 disabled:opacity-60"
                />
              </Field>
            </div>
          )}
        </div>

        {!readOnly && (
          <footer className="flex justify-end gap-2 border-t border-ink/10 px-5 py-3">
            <button type="button" onClick={onClose} className="h-8 rounded-md px-3 text-[12px] text-ink/50 hover:bg-ink/[0.05]">{t("agents.cancel")}</button>
            <button type="button" onClick={onSave} disabled={!canSave} className="btn-primary h-8 px-3 text-[12px]">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              {saving ? t("agents.saving") : t("agents.save")}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="block space-y-1.5">
      <span className="text-[11.5px] font-medium text-ink/55">{label}</span>
      {children}
    </div>
  );
}
