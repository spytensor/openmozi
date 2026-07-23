import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Blocks,
  Bot,
  CheckCircle2,
  CircleSlash,
  Clapperboard,
  Code2,
  FileType2,
  FileText,
  Files,
  FlaskConical,
  Hammer,
  LayoutTemplate,
  Loader2,
  Megaphone,
  MessageSquare,
  Palette,
  PenLine,
  Plug,
  Presentation,
  Save,
  Search,
  Settings2,
  Sheet,
  Shield,
  Sparkles,
  SwatchBook,
  Tag,
  Waves,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { TypeIcon } from "@/components/chat/artifact-type-icons";
import { CHAT_PROSE_CLASS } from "@/components/chat/prose";
import type { SkillDetail, SkillInfo, SkillInstallSpec } from "@/types/management";
import { cn } from "@/lib/utils";
import WorkspacePage from "@/components/layout/WorkspacePage";
import { useLocale, type MessageKey } from "@/i18n";
import { MARKDOWN_COMPONENTS } from "@/components/chat/markdown-link";
import { normalizeMarkdownTables } from "@/components/chat/markdown-normalize";

type Filter = "all" | "ready" | "needs-setup";

const BUILTIN_SKILL_COPY: Record<string, { name: MessageKey; description: MessageKey }> = {
  "algorithmic-art": {
    name: "skills.builtin.algorithmicArt.name",
    description: "skills.builtin.algorithmicArt.description",
  },
  "brand-guidelines": {
    name: "skills.builtin.brandGuidelines.name",
    description: "skills.builtin.brandGuidelines.description",
  },
  "canvas-design": {
    name: "skills.builtin.canvasDesign.name",
    description: "skills.builtin.canvasDesign.description",
  },
  "coding-agent": {
    name: "skills.builtin.codingAgent.name",
    description: "skills.builtin.codingAgent.description",
  },
  "claude-api": {
    name: "skills.builtin.claudeApi.name",
    description: "skills.builtin.claudeApi.description",
  },
  "doc-coauthoring": {
    name: "skills.builtin.docCoauthoring.name",
    description: "skills.builtin.docCoauthoring.description",
  },
  docx: {
    name: "skills.builtin.docx.name",
    description: "skills.builtin.docx.description",
  },
  "frontend-design": {
    name: "skills.builtin.frontendDesign.name",
    description: "skills.builtin.frontendDesign.description",
  },
  "internal-comms": {
    name: "skills.builtin.internalComms.name",
    description: "skills.builtin.internalComms.description",
  },
  "mcp-builder": {
    name: "skills.builtin.mcpBuilder.name",
    description: "skills.builtin.mcpBuilder.description",
  },
  pdf: {
    name: "skills.builtin.pdf.name",
    description: "skills.builtin.pdf.description",
  },
  pptx: {
    name: "skills.builtin.pptx.name",
    description: "skills.builtin.pptx.description",
  },
  "skill-creator": {
    name: "skills.builtin.skillCreator.name",
    description: "skills.builtin.skillCreator.description",
  },
  "slack-gif-creator": {
    name: "skills.builtin.slackGifCreator.name",
    description: "skills.builtin.slackGifCreator.description",
  },
  "theme-factory": {
    name: "skills.builtin.themeFactory.name",
    description: "skills.builtin.themeFactory.description",
  },
  "web-artifacts-builder": {
    name: "skills.builtin.webArtifactsBuilder.name",
    description: "skills.builtin.webArtifactsBuilder.description",
  },
  "webapp-testing": {
    name: "skills.builtin.webappTesting.name",
    description: "skills.builtin.webappTesting.description",
  },
  xlsx: {
    name: "skills.builtin.xlsx.name",
    description: "skills.builtin.xlsx.description",
  },
};

const CATEGORY_ORDER = ["utility", "media", "coding", "communication", "research", "system", "other"] as const;

type CategorySectionKey = typeof CATEGORY_ORDER[number];

const BUNDLED_SKILL_ICONS: Record<string, LucideIcon> = {
  "algorithmic-art": Waves,
  "brand-guidelines": Tag,
  "canvas-design": Palette,
  "claude-api": Bot,
  "coding-agent": Code2,
  "doc-coauthoring": PenLine,
  docx: FileText,
  "frontend-design": LayoutTemplate,
  "internal-comms": Megaphone,
  "mcp-builder": Plug,
  pdf: FileType2,
  pptx: Presentation,
  "skill-creator": Hammer,
  "slack-gif-creator": Clapperboard,
  "theme-factory": SwatchBook,
  "web-artifacts-builder": Blocks,
  "webapp-testing": FlaskConical,
  xlsx: Sheet,
};

const CATEGORY_DEFAULT_ICONS: Record<CategorySectionKey, LucideIcon> = {
  utility: FileText,
  media: Palette,
  coding: Code2,
  communication: MessageSquare,
  research: Search,
  system: Settings2,
  other: Sparkles,
};

export default function SkillsView() {
  const { t } = useLocale();
  const { get, put, post } = useApi();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [editorContent, setEditorContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [stateSaving, setStateSaving] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await get<{ skills: SkillInfo[] }>("/api/skills");
      if (!cancelled) {
        setSkills(data?.skills ?? []);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [get]);

  useEffect(() => {
    if (!selectedSkillId) {
      setDetail(null);
      setDetailError(null);
      setEditorContent("");
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    setMutationError(null);

    (async () => {
      const { data, error } = await get<{ skill: SkillDetail }>(`/api/skills/${encodeURIComponent(selectedSkillId)}`);
      if (cancelled) return;
      if (error || !data?.skill) {
        setDetail(null);
        setDetailError(error || t("skills.detail.loadError"));
      } else {
        setDetail(data.skill);
        setEditorContent(data.skill.content);
      }
      setDetailLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [get, selectedSkillId, t]);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return skills.filter((skill) => {
      const missing = hasMissingRequirements(skill);
      if (statusFilter === "ready" && (skill.status !== "active" || missing)) return false;
      if (statusFilter === "needs-setup" && !missing) return false;
      if (!query) return true;
      const display = displaySkillCopy(skill, t);
      const haystack = [
        display.name,
        display.description,
        skill.name,
        skill.description,
        skill.source,
        skill.directory_name,
        ...(skill.missing_bins ?? []),
        ...(skill.missing_env ?? []),
      ].filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }, [filter, skills, statusFilter, t]);

  const grouped = useMemo(() => groupSkillsByCategory(filtered), [filtered]);

  function mergeSkillRecord(updated: SkillInfo): void {
    const updatedId = skillStableId(updated);
    setSkills((current) => current.map((skill) => (
      skillStableId(skill) === updatedId
        ? {
          ...skill,
          ...updated,
          status: updated.enabled === false ? "disabled" : "active",
        }
        : skill
    )));
  }

  async function saveWorkspaceSkill(): Promise<void> {
    if (!detail || detail.source !== "workspace") return;
    setSaving(true);
    setMutationError(null);
    const { data, error } = await put<{ skill: SkillDetail }>(
      `/api/skills/${encodeURIComponent(detail.id ?? skillStableId(detail))}`,
      { content: editorContent },
    );
    setSaving(false);
    if (error || !data?.skill) {
      setMutationError(error || t("skills.detail.saveError"));
      return;
    }
    setDetail(data.skill);
    setEditorContent(data.skill.content);
    mergeSkillRecord(data.skill);
  }

  async function toggleWorkspaceSkill(): Promise<void> {
    if (!detail || detail.source !== "workspace") return;
    const nextEnabled = !(detail.enabled ?? detail.status === "active");
    setStateSaving(true);
    setMutationError(null);
    const { data, error } = await post<{ skill: SkillInfo }>(
      `/api/skills/${encodeURIComponent(detail.id ?? skillStableId(detail))}/state`,
      { enabled: nextEnabled },
    );
    setStateSaving(false);
    if (error || !data?.skill) {
      setMutationError(error || t("skills.detail.stateError"));
      return;
    }

    const updatedDetail: SkillDetail = {
      ...detail,
      ...data.skill,
      status: data.skill.enabled === false ? "disabled" : "active",
    };
    setDetail(updatedDetail);
    mergeSkillRecord(data.skill);
  }

  return (
    <WorkspacePage contentClassName="max-w-[1180px]">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-[12px] text-ink/35">
            <Sparkles className="h-3.5 w-3.5" />
            <span>{t("skills.kicker")}</span>
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-normal text-ink/85">{t("skills.title")}</h1>
          <p className="mt-1 max-w-[700px] text-[12.5px] leading-5 text-ink/40">{t("skills.description")}</p>
        </div>
        <div className="flex min-w-[260px] flex-1 items-center gap-2 sm:max-w-[420px]">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink/30" />
            <input
              type="search"
              name="skills-search"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              data-1p-ignore
              data-lpignore="true"
              data-form-type="other"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("skills.search")}
              className="input-field pl-9"
            />
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <FilterButton active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>{t("skills.filter.all")}</FilterButton>
        <FilterButton active={statusFilter === "ready"} onClick={() => setStatusFilter("ready")}>{t("skills.filter.ready")}</FilterButton>
        <FilterButton active={statusFilter === "needs-setup"} onClick={() => setStatusFilter("needs-setup")}>{t("skills.filter.needsSetup")}</FilterButton>
      </div>

      {loading ? (
        <p className="py-8 text-center text-xs text-ink/30">{t("skills.loading")}</p>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center">
          <Sparkles size={32} className="mx-auto mb-3 text-ink/10" />
          <p className="text-sm text-ink/40">{skills.length === 0 ? t("skills.empty") : t("skills.noMatches")}</p>
        </div>
      ) : (
        <div className="space-y-7">
          {grouped.map(({ key, skills: sectionSkills }) => (
            <section key={key} className="space-y-3">
              <div className="flex items-center justify-between gap-3 border-b border-ink/[0.06] pb-2">
                <h2 className="text-[12px] font-semibold uppercase text-ink/46">
                  {categorySectionLabel(key, t)}
                </h2>
                <span className="text-[11px] text-ink/28">{sectionCountLabel(sectionSkills.length, t)}</span>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {sectionSkills.map((skill) => (
                  <SkillCard key={skill.id ?? skill.name} skill={skill} onOpen={() => setSelectedSkillId(skillStableId(skill))} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {selectedSkillId ? (
        <SkillDetailDrawer
          detail={detail}
          loading={detailLoading}
          error={detailError}
          editorContent={editorContent}
          mutationError={mutationError}
          saving={saving}
          stateSaving={stateSaving}
          onEditorChange={setEditorContent}
          onClose={() => setSelectedSkillId(null)}
          onSave={saveWorkspaceSkill}
          onToggleState={toggleWorkspaceSkill}
        />
      ) : null}
    </WorkspacePage>
  );
}

function skillStableId(skill: Pick<SkillInfo, "id" | "source" | "name" | "directory_name">): string {
  if (skill.id) return skill.id;
  return `${skill.source ?? "bundled"}:${skill.directory_name ?? skill.name}`;
}

function hasMissingRequirements(skill: SkillInfo): boolean {
  const disabled = skill.enabled === false || skill.status !== "active";
  return (skill.missing_bins?.length ?? 0) > 0 || (skill.missing_env?.length ?? 0) > 0 || (skill.eligible === false && !disabled);
}

type TFunction = ReturnType<typeof useLocale>["t"];

function skillStatus(skill: SkillInfo, t: TFunction): { label: string; tone: "success" | "warning" | "muted"; icon: LucideIcon } {
  if (skill.status !== "active") {
    return { label: t("skills.status.disabled"), tone: "muted", icon: CircleSlash };
  }
  if (hasMissingRequirements(skill)) {
    return { label: t("skills.status.missingRequirements"), tone: "warning", icon: Wrench };
  }
  return { label: t("skills.status.ready"), tone: "success", icon: CheckCircle2 };
}

function sourceLabel(skill: SkillInfo, t: TFunction): string {
  if (skill.source === "bundled") return t("skills.source.bundled");
  if (skill.source === "workspace") return t("skills.source.workspace");
  return t("skills.source.unknown");
}

function requirementLabel(skill: SkillInfo, t: TFunction): string {
  if (skill.missing_bins?.length) return t("skills.dependencies.missingBins", { items: skill.missing_bins.join(", ") });
  if (skill.missing_env?.length) return t("skills.dependencies.missingEnv", { items: skill.missing_env.join(", ") });
  return t("skills.dependencies.ready");
}

function sandboxProfileLabel(profile: string | null | undefined, t: TFunction): string {
  if (!profile) return t("skills.sandbox.default");
  if (profile === "read-only") return t("skills.sandbox.readOnly");
  if (profile === "workspace-write") return t("skills.sandbox.workspaceWrite");
  if (profile === "adapter-managed") return t("skills.sandbox.adapterManaged");
  return profile;
}

function displaySkillCopy(skill: Pick<SkillInfo, "id" | "directory_name" | "name" | "description">, t: TFunction): { name: string; description: string } {
  const candidates = [skill.id, skill.directory_name, skill.name].filter((candidate): candidate is string => Boolean(candidate));
  const builtInCopy = candidates
    .flatMap((candidate) => [candidate, candidate.includes(":") ? candidate.split(":").at(-1) ?? candidate : candidate])
    .map((candidate) => BUILTIN_SKILL_COPY[candidate])
    .find(Boolean);
  if (builtInCopy) {
    return {
      name: t(builtInCopy.name),
      description: t(builtInCopy.description),
    };
  }
  return {
    name: humanizeSkillName(skill.name),
    description: skill.description,
  };
}

function humanizeSkillName(name: string): string {
  const upperCaseNames = new Set(["docx", "pdf", "pptx", "xlsx", "mcp", "api", "gif"]);
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => (upperCaseNames.has(part.toLowerCase()) ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(" ");
}

function categoryKey(skill: Pick<SkillInfo, "category">): CategorySectionKey {
  const category = skill.category;
  if (category === "utility") return "utility";
  if (category === "media") return "media";
  if (category === "coding") return "coding";
  if (category === "communication") return "communication";
  if (category === "research") return "research";
  if (category === "system") return "system";
  return "other";
}

function categorySectionLabel(category: CategorySectionKey, t: TFunction): string {
  const labels: Record<CategorySectionKey, MessageKey> = {
    utility: "skills.category.documents",
    media: "skills.category.media",
    coding: "skills.category.coding",
    communication: "skills.category.communication",
    research: "skills.category.research",
    system: "skills.category.system",
    other: "skills.category.other",
  };
  return t(labels[category]);
}

function sectionCountLabel(count: number, t: TFunction): string {
  return t(count === 1 ? "skills.section.countOne" : "skills.section.countMany", { count });
}

function groupSkillsByCategory(skills: SkillInfo[]): Array<{ key: CategorySectionKey; skills: SkillInfo[] }> {
  const groups = new Map<CategorySectionKey, SkillInfo[]>();
  for (const skill of skills) {
    const key = categoryKey(skill);
    groups.set(key, [...(groups.get(key) ?? []), skill]);
  }
  return CATEGORY_ORDER
    .map((key) => ({ key, skills: groups.get(key) ?? [] }))
    .filter((group) => group.skills.length > 0);
}

function categoryAccentClass(category: CategorySectionKey): string {
  // Tinted fill only — a border around an icon tile reads as a frame with a
  // small glyph rattling inside it (the "empty box" anti-pattern).
  const classes: Record<CategorySectionKey, string> = {
    utility: "bg-selection/10 text-selection",
    media: "bg-warning/10 text-warning",
    coding: "bg-success/10 text-success",
    communication: "bg-error/10 text-error",
    research: "bg-link/10 text-link",
    system: "bg-ink/[0.06] text-ink/62",
    other: "bg-ink/[0.04] text-ink/52",
  };
  return classes[category];
}

function skillDirectoryKey(skill: Pick<SkillInfo, "id" | "directory_name" | "name">): string {
  return skill.directory_name ?? skill.id?.split(":").at(-1) ?? skill.name;
}

function skillIconComponent(skill: Pick<SkillInfo, "id" | "directory_name" | "name" | "category">): LucideIcon {
  return BUNDLED_SKILL_ICONS[skillDirectoryKey(skill)] ?? CATEGORY_DEFAULT_ICONS[categoryKey(skill)];
}

// Skills that ARE file types render the shared colorful file glyph (same system
// as artifacts and attachment chips) instead of a monochrome lucide icon.
const FILE_TYPE_SKILL_GLYPH: Record<string, string> = {
  docx: "document",
  pdf: "pdf",
  pptx: "deck",
  xlsx: "sheet",
};

function SkillIconTile({ skill, size = "md" }: { skill: SkillInfo | SkillDetail; size?: "md" | "lg" }) {
  const Icon = skillIconComponent(skill);
  const category = categoryKey(skill);
  const iconKey = skillDirectoryKey(skill);
  const fileGlyph = FILE_TYPE_SKILL_GLYPH[iconKey];
  const tilePx = size === "lg" ? 48 : 44;

  // File-type skills use the colorful file glyph, which is a self-contained
  // filled icon — render it edge-to-edge instead of shrinking it inside a
  // bordered accent box (which read as "a frame with a tiny icon in it").
  if (fileGlyph) {
    return (
      <div
        data-testid={`skill-icon-${iconKey}`}
        className="flex flex-shrink-0 items-center justify-center"
        style={{ width: tilePx, height: tilePx }}
        aria-hidden="true"
      >
        <TypeIcon type={fileGlyph} size={tilePx} />
      </div>
    );
  }

  return (
    <div
      data-testid={`skill-icon-${iconKey}`}
      className={cn(
        "flex flex-shrink-0 items-center justify-center rounded-md",
        categoryAccentClass(category),
        size === "lg" ? "h-12 w-12 text-[24px]" : "h-11 w-11 text-[22px]",
      )}
      aria-hidden="true"
    >
      <Icon className={size === "lg" ? "h-6 w-6" : "h-5 w-5"} strokeWidth={2} />
    </div>
  );
}

function SkillCard({ skill, onOpen }: { skill: SkillInfo; onOpen: () => void }) {
  const { t } = useLocale();
  const display = displaySkillCopy(skill, t);
  const disabled = skill.enabled === false || skill.status !== "active";
  const missingRequirements = hasMissingRequirements(skill);
  const category = categoryKey(skill);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("skills.detail.open", { name: display.name })}
      className="card-surface group min-w-0 p-4 text-left transition-all duration-180ms hover:-translate-y-0.5 hover:border-selection/35 hover:bg-elevated/80 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-focus/45"
    >
      <div className="flex min-w-0 items-start gap-3.5">
        <SkillIconTile skill={skill} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <h3 className="min-w-0 text-[14px] font-semibold leading-5 text-ink/84">{display.name}</h3>
            <div className="flex flex-shrink-0 flex-wrap justify-end gap-1.5">
              {missingRequirements ? (
                <Badge tone="warning">
                  <Wrench className="h-3 w-3" />
                  {t("skills.status.missingRequirements")}
                </Badge>
              ) : null}
              {disabled ? (
                <Badge tone="muted">
                  <CircleSlash className="h-3 w-3" />
                  {t("skills.status.disabled")}
                </Badge>
              ) : null}
              {skill.source === "workspace" ? <Badge tone="muted">{t("skills.source.workspace")}</Badge> : null}
            </div>
          </div>
          {/* No category footer chip: the card already sits under its
              category's section header — repeating it inside every card was
              triple labeling (same rule as the sidebar PROJECTS cleanup). */}
          <p className="mt-2 line-clamp-2 text-[12.5px] leading-5 text-ink/48">{display.description}</p>
        </div>
      </div>
    </button>
  );
}

function SkillDetailDrawer({
  detail,
  loading,
  error,
  editorContent,
  mutationError,
  saving,
  stateSaving,
  onEditorChange,
  onClose,
  onSave,
  onToggleState,
}: {
  detail: SkillDetail | null;
  loading: boolean;
  error: string | null;
  editorContent: string;
  mutationError: string | null;
  saving: boolean;
  stateSaving: boolean;
  onEditorChange: (content: string) => void;
  onClose: () => void;
  onSave: () => void;
  onToggleState: () => void;
}) {
  const { t } = useLocale();
  const normalizedDetail = detail ? { ...detail, status: detail.enabled === false ? "disabled" as const : "active" as const } : null;
  const display = normalizedDetail ? displaySkillCopy(normalizedDetail, t) : null;
  const status = normalizedDetail ? skillStatus(normalizedDetail, t) : null;
  const StatusIcon = status?.icon;
  const canEdit = normalizedDetail?.source === "workspace";
  const isEnabled = normalizedDetail ? normalizedDetail.enabled !== false : false;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/35" role="dialog" aria-modal="true">
      <div className="flex h-full w-full max-w-[860px] flex-col overflow-hidden border-l border-ink/10 bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-ink/10 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3.5">
            {normalizedDetail ? <SkillIconTile skill={normalizedDetail} size="lg" /> : null}
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h2 className="truncate text-[18px] font-semibold text-ink/85">{display?.name ?? t("skills.detail.title")}</h2>
                {status && StatusIcon ? (
                  <Badge tone={status.tone}>
                    <StatusIcon className="h-3 w-3" />
                    {status.label}
                  </Badge>
                ) : null}
                {normalizedDetail ? <Badge tone="muted">{sourceLabel(normalizedDetail, t)}</Badge> : null}
                {normalizedDetail?.source === "bundled" ? <Badge tone="muted">{t("skills.detail.readOnly")}</Badge> : null}
              </div>
              {display ? <p className="mt-2 max-w-[720px] text-[12.5px] leading-5 text-ink/45">{display.description}</p> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("skills.detail.close")}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/10 hover:text-ink/70"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center gap-2 py-10 text-sm text-ink/45">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("skills.detail.loading")}
            </div>
          ) : error ? (
            <p className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          ) : normalizedDetail ? (
            <div className="space-y-5">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <CapabilityFact icon={Shield} label={normalizedDetail.user_invocable ? t("skills.invocation.user") : t("skills.invocation.runtime")} />
                <CapabilityFact icon={Wrench} label={requirementLabel(normalizedDetail, t)} />
                <CapabilityFact icon={Shield} label={`${t("skills.sandbox")}: ${sandboxProfileLabel(normalizedDetail.sandbox_profile, t)}`} />
                <CapabilityFact icon={Sparkles} label={`${t("skills.internalName")}: ${normalizedDetail.directory_name ?? normalizedDetail.name}`} mono />
              </div>

              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-ink/70">{t("skills.detail.requirements")}</h3>
                <div className="rounded-md border border-ink/10 bg-ink/[0.025] px-3 py-2 text-[12px] leading-5 text-ink/55">
                  {requirementLines(normalizedDetail, t).map((line) => (
                    <div key={line}>{line}</div>
                  ))}
                  {normalizedDetail.frontmatter.install?.length ? (
                    <div className="mt-2 border-t border-ink/10 pt-2">
                      <div className="mb-1 font-medium text-ink/60">{t("skills.detail.install")}</div>
                      {normalizedDetail.frontmatter.install.map((spec, index) => (
                        <div key={`${spec.kind}-${index}`}>{installSpecLabel(spec)}</div>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>

              {canEdit ? (
                <section className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-[13px] font-semibold text-ink/70">{t("skills.detail.editor")}</h3>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-2 rounded-md border border-ink/10 bg-ink/[0.025] px-2.5 py-1.5 text-[12px] text-ink/55">
                        <input
                          type="checkbox"
                          checked={isEnabled}
                          disabled={stateSaving}
                          onChange={onToggleState}
                          className="h-3.5 w-3.5 accent-[var(--action)]"
                        />
                        {isEnabled ? t("skills.detail.enabled") : t("skills.detail.disabled")}
                      </label>
                      <button
                        type="button"
                        onClick={onSave}
                        disabled={saving}
                        className="btn-primary h-8 px-3 text-[12px]"
                      >
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        {saving ? t("skills.detail.saving") : t("skills.detail.save")}
                      </button>
                    </div>
                  </div>
                  {mutationError ? (
                    <p className="rounded-md border border-danger/25 bg-danger/10 px-3 py-2 text-[12px] text-danger">{mutationError}</p>
                  ) : null}
                  <textarea
                    aria-label={t("skills.detail.editor")}
                    value={editorContent}
                    onChange={(event) => onEditorChange(event.target.value)}
                    spellCheck={false}
                    className="h-[320px] w-full resize-y rounded-md border border-ink/10 bg-[var(--code-bg)] px-3 py-2 font-mono text-[12px] leading-5 text-ink/72 outline-none focus:border-focus/50"
                  />
                </section>
              ) : null}

              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold text-ink/70">{t("skills.detail.content")}</h3>
                <MarkdownPreview content={canEdit ? editorContent : normalizedDetail.content} />
              </section>

              <section className="space-y-2">
                <h3 className="flex items-center gap-2 text-[13px] font-semibold text-ink/70">
                  <Files className="h-3.5 w-3.5" />
                  {t("skills.detail.files")}
                </h3>
                {normalizedDetail.files.length === 0 ? (
                  <p className="rounded-md border border-ink/10 bg-ink/[0.025] px-3 py-2 text-[12px] text-ink/45">{t("skills.detail.noFiles")}</p>
                ) : (
                  <div className="max-h-[260px] overflow-y-auto rounded-md border border-ink/10">
                    {normalizedDetail.files.map((file) => (
                      <div key={file.name} className="flex items-center justify-between gap-3 border-b border-ink/[0.06] px-3 py-2 last:border-b-0">
                        <span className="min-w-0 truncate font-mono text-[12px] text-ink/62">{file.name}</span>
                        <span className="flex-shrink-0 text-[11px] text-ink/35">{formatBytes(file.size)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <CapabilityFact icon={FileText} label={`${t("skills.detail.filePath")}: ${normalizedDetail.file_path}`} mono />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function requirementLines(detail: SkillDetail, t: TFunction): string[] {
  const requires = detail.frontmatter.requires;
  const lines: string[] = [];
  if (requires?.bins?.length) {
    lines.push(t("skills.detail.requiresBins", { items: requires.bins.join(", ") }));
  }
  if (requires?.anyBins?.length) {
    lines.push(t("skills.detail.requiresAnyBins", { items: requires.anyBins.join(", ") }));
  }
  if (requires?.env?.length) {
    lines.push(t("skills.detail.requiresEnv", { items: requires.env.join(", ") }));
  }
  return lines.length > 0 ? lines : [t("skills.detail.noRequirements")];
}

function installSpecLabel(spec: SkillInstallSpec): string {
  if (spec.label) return spec.label;
  if (spec.kind === "manual" && spec.command) return spec.command;
  if (spec.formula) return `${spec.kind}: ${spec.formula}`;
  if (spec.package) return `${spec.kind}: ${spec.package}`;
  return spec.kind;
}

function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="rounded-md border border-ink/10 bg-ink/[0.025] px-4 py-3">
      {/* Shared reading-surface spec (chat/prose): the old inline `prose
          prose-invert` classes were dead — Typography was never registered. */}
      <div className={`${CHAT_PROSE_CLASS} text-ink/[0.82]`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
          {normalizeMarkdownTables(content)}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("rounded-md px-3 py-1.5 text-[12.5px] transition-colors", active ? "text-ink/80" : "text-ink/42")}
      style={{
        background: active ? "var(--surface-active)" : "var(--surface-input)",
        border: "1px solid var(--border-subtle)",
      }}
    >
      {children}
    </button>
  );
}

function CapabilityFact({ icon: Icon, label, mono = false }: { icon: LucideIcon; label: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md bg-ink/[0.03] px-2.5 py-2">
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-ink/35" />
      <span className={cn("min-w-0 truncate text-[11.5px] text-ink/46", mono && "font-mono")}>{label}</span>
    </div>
  );
}

function Badge({ tone, children }: { tone: "success" | "warning" | "muted"; children: ReactNode }) {
  const className = tone === "success"
    ? "bg-success/20 text-success"
    : tone === "warning"
      ? "bg-warning/20 text-warning"
      : "bg-ink/10 text-ink/45";
  return <span className={cn("badge gap-1", className)}>{children}</span>;
}
