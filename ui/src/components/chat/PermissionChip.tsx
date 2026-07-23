import { useEffect, useState } from "react";
import { Check, ChevronDown, Hand, Loader2, ShieldAlert, type LucideIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApi } from "@/hooks/useApi";
import { useLocale, type MessageKey } from "@/i18n";

export type PermissionLevel =
  | "L0_READ_ONLY"
  | "L1_READ_WRITE"
  | "L2_SHELL_EXEC"
  | "L3_FULL_ACCESS";

export const PERMISSION_LEVELS: PermissionLevel[] = [
  "L0_READ_ONLY",
  "L1_READ_WRITE",
  "L2_SHELL_EXEC",
  "L3_FULL_ACCESS",
];

/** Product-facing choices. Intermediate levels remain an engine concern. */
export const ACCESS_MODE_LEVELS: PermissionLevel[] = ["L1_READ_WRITE", "L3_FULL_ACCESS"];

type PermissionTone = "neutral" | "warning" | "danger";

export const PERMISSION_META: Record<PermissionLevel, {
  nameKey: MessageKey;
  descriptionKey: MessageKey;
  icon: LucideIcon;
  tone: PermissionTone;
}> = {
  L0_READ_ONLY: {
    nameKey: "composer.permission.l1.name",
    descriptionKey: "composer.permission.l1.description",
    icon: Hand,
    tone: "neutral",
  },
  L1_READ_WRITE: {
    nameKey: "composer.permission.l1.name",
    descriptionKey: "composer.permission.l1.description",
    icon: Hand,
    tone: "neutral",
  },
  L2_SHELL_EXEC: {
    nameKey: "composer.permission.l1.name",
    descriptionKey: "composer.permission.l1.description",
    icon: Hand,
    tone: "neutral",
  },
  L3_FULL_ACCESS: {
    nameKey: "composer.permission.l3.name",
    descriptionKey: "composer.permission.l3.description",
    icon: ShieldAlert,
    tone: "neutral",
  },
};

/** Tone → color for the trigger only; menu icons stay neutral ink for restraint. */
const TONE_COLOR: Record<PermissionTone, string | undefined> = {
  neutral: undefined,
  warning: "var(--warning)",
  danger: "var(--danger)",
};

interface PermissionResponse {
  sessionId: string;
  permission_level: PermissionLevel;
}

const PERMISSION_LEVEL_EVENT = "mozi:permission-level-updated";

function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === "string" && (PERMISSION_LEVELS as string[]).includes(value);
}

export function PermissionChip({ sessionId }: { sessionId?: string | null }) {
  const { t } = useLocale();
  const { get, patch } = useApi();
  const [level, setLevel] = useState<PermissionLevel | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingLevel, setPendingLevel] = useState<PermissionLevel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!sessionId) {
      setLevel(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    get<PermissionResponse>(`/api/sessions/${sessionId}/permission-level`).then(({ data, error: loadError }) => {
      if (cancelled) return;
      if (data?.permission_level) {
        setLevel(data.permission_level);
      } else if (loadError) {
        // Load failure (old backend without the endpoint) hides the chip —
        // not a user-initiated change, so no error toast.
        setLevel(null);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [get, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const onPermissionLevelUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; permission_level?: unknown }>).detail;
      if (detail?.sessionId !== sessionId || !isPermissionLevel(detail.permission_level)) return;
      setLevel(detail.permission_level);
      setError(null);
      setLoading(false);
    };
    window.addEventListener(PERMISSION_LEVEL_EVENT, onPermissionLevelUpdated);
    return () => window.removeEventListener(PERMISSION_LEVEL_EVENT, onPermissionLevelUpdated);
  }, [sessionId]);

  if (!sessionId) return null;
  // Quiet degradation: no stored level and not loading means the backend
  // can't serve it — the chip simply doesn't render.
  if (!loading && !level) return null;

  const meta = level ? PERMISSION_META[level] : null;
  const label = meta ? t(meta.nameKey) : t("common.loading");
  const errorLabel = error ? t("composer.permission.updateFailed", { error }) : null;
  const TriggerIcon = meta?.icon;
  const toneColor = meta ? TONE_COLOR[meta.tone] : undefined;

  const selectLevel = async (nextLevel: PermissionLevel) => {
    if (!sessionId || nextLevel === level || pendingLevel) return;
    setPendingLevel(nextLevel);
    setError(null);
    const { data, error: patchError } = await patch<PermissionResponse>(`/api/sessions/${sessionId}/permission-level`, {
      permission_level: nextLevel,
    });
    setPendingLevel(null);
    if (data?.permission_level) {
      setLevel(data.permission_level);
      return;
    }
    setError(patchError ?? t("common.unavailable"));
  };

  return (
    <div className="relative min-w-0">
      {errorLabel && (
        <div
          data-testid="permission-chip-error"
          className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[260px] rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-4 text-warning"
        >
          {errorLabel}
        </div>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!level || loading}>
          <button
            type="button"
            data-testid="permission-chip"
            className="inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] text-ink/70 transition-all duration-200 hover:bg-white/[0.04] hover:text-ink/95 disabled:cursor-not-allowed disabled:opacity-60 active:scale-[0.98]"
            style={toneColor ? { color: toneColor } : undefined}
            title={label}
            aria-label={label}
          >
            {loading ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ink/40" />
            ) : (
              TriggerIcon && <TriggerIcon className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 max-w-[120px] truncate">{label}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          data-testid="permission-menu"
          side="top"
          align="end"
          sideOffset={8}
          className="w-[260px] rounded-xl border border-white/[0.08] bg-surface-overlay p-1.5 text-ink shadow-2xl backdrop-blur-xl"
        >
          <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-ink/45">
            {t("composer.permission.menuLabel")}
          </DropdownMenuLabel>
          {ACCESS_MODE_LEVELS.map((option) => {
            const optionMeta = PERMISSION_META[option];
            const OptionIcon = optionMeta.icon;
            const active = option === "L3_FULL_ACCESS"
              ? level === "L3_FULL_ACCESS"
              : level !== "L3_FULL_ACCESS";
            return (
              <DropdownMenuItem
                key={option}
                data-permission-option={option}
                disabled={!!pendingLevel}
                onSelect={() => selectLevel(option)}
                className="flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors focus:bg-white/[0.04] hover:bg-white/[0.04] focus:text-ink data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45"
              >
                <OptionIcon className="mt-0.5 h-[18px] w-[18px] shrink-0 text-ink/70" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink/90">
                    {t(optionMeta.nameKey)}
                    {pendingLevel === option && <Loader2 className="h-3 w-3 animate-spin text-ink/45" />}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-[1.35] text-ink/40">{t(optionMeta.descriptionKey)}</span>
                </span>
                {active && <Check className="mt-0.5 h-4 w-4 shrink-0 text-selection" />}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
