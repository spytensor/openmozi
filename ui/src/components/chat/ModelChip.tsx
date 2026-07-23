import { lazy, Suspense, useMemo, useState } from "react";
import { AlertCircle, ChevronDown, Loader2, RotateCw, Settings } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { useLocale } from "@/i18n";
import {
  applyRoleReadinessToProviders,
  findProvider,
  modelDisplayName,
  providerBrainEligible,
  type CatalogModel,
  type CatalogProvider,
  type ModelRoles,
} from "@/lib/model-catalog";
import { setModelState, useModelState } from "@/hooks/useModelState";

const ModelPickerMenu = lazy(() => import("@/components/models/ModelPickerMenu").then(module => ({ default: module.ModelPickerMenu })));
const ProviderBadge = lazy(() => import("@/components/models/ProviderBadge").then(module => ({ default: module.ProviderBadge })));

interface RolesPatchResponse {
  success: boolean;
  roles: ModelRoles;
}

interface ModelChipProps {
  canConfigureModels?: boolean;
  onOpenModelSettings?: () => void;
}

export function ModelChip({ canConfigureModels = false, onOpenModelSettings }: ModelChipProps) {
  const { t } = useLocale();
  const { patch } = useApi();
  const modelState = useModelState();
  const roles = modelState.data?.roles ?? null;
  const providers = useMemo(() => modelState.data?.providers ?? [], [modelState.data?.providers]);
  const loading = modelState.isPending;
  const loadError = modelState.data?.rolesError || modelState.data?.providerError || modelState.isError
    ? t("models.loadError")
    : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const brain = roles?.brain;
  const brainConfigured = !!brain?.provider.trim() && !!brain.model.trim();
  const currentProvider = brain ? findProvider(providers, brain.provider) : undefined;
  const label = brain ? modelDisplayName(providers, brain.provider, brain.model) : t("common.loading");
  const errorLabel = error ? t("composer.model.updateFailed", { error }) : null;
  const pickerProviders = useMemo(
    () => providers.filter((provider) => provider.models.length > 0 && providerBrainEligible(provider)),
    [providers],
  );

  if (!loading && loadError && !brainConfigured) {
    return (
      <button
        type="button"
        data-testid="model-chip-load-error"
        onClick={() => void modelState.refetch()}
        className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-warning transition-colors hover:bg-warning/10"
        title={t("composer.model.retryLoad")}
        aria-label={t("composer.model.retryLoad")}
      >
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{loadError}</span>
        <RotateCw className="h-3 w-3 shrink-0" />
      </button>
    );
  }

  if (!loading && !brainConfigured) {
    if (canConfigureModels && onOpenModelSettings) {
      return (
        <button
          type="button"
          data-testid="model-chip-configure"
          onClick={onOpenModelSettings}
          className="inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-ink/60 transition-colors hover:bg-[var(--surface-hover)] hover:text-ink/82"
        >
          <Settings className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{t("composer.model.configure")}</span>
        </button>
      );
    }
    return (
      <span
        data-testid="model-chip-admin-managed"
        className="inline-flex h-7 min-w-0 items-center px-2 text-[12px] text-ink/45"
        title={t("composer.model.adminManaged")}
      >
        {t("composer.model.adminManaged")}
      </span>
    );
  }

  const selectModel = async (provider: CatalogProvider, model: CatalogModel) => {
    if (!canConfigureModels || !model.id || saving) return;
    if (brain?.provider === provider.id && brain.model === model.id) return;
    setSaving(true);
    setError(null);
    const { data, error: patchError } = await patch<RolesPatchResponse>("/api/models/roles", {
      brain: { provider: provider.id, model: model.id },
    });
    setSaving(false);
    if (data?.roles) {
      setModelState({
        roles: data.roles,
        providers: applyRoleReadinessToProviders(providers, data.roles),
        rolesError: null,
        providerError: modelState.data?.providerError ?? null,
      });
      return;
    }
    setError(patchError ?? t("common.unavailable"));
  };

  return (
    <div className="relative min-w-0">
      {errorLabel && (
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-30 w-[260px] rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-4 text-warning">
          {errorLabel}
        </div>
      )}
      {loadError && (
        <div className="absolute bottom-[calc(100%+6px)] left-0 z-30 flex w-[280px] items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-1.5 text-[11px] leading-4 text-warning">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{loadError}</span>
          <button
            type="button"
            onClick={() => void modelState.refetch()}
            className="inline-flex shrink-0 items-center gap-1 underline underline-offset-4"
          >
            <RotateCw className="h-3 w-3" />
            {t("common.retry")}
          </button>
        </div>
      )}
      <Suspense fallback={<span className="inline-block h-7 w-[108px] rounded-md bg-ink/[0.035]" />}>
        <ModelPickerMenu
          providers={pickerProviders}
          selectedProvider={brain?.provider}
          selectedModel={brain?.model}
          onSelect={selectModel}
          disabled={loading || !brain || saving || !canConfigureModels}
          trigger={
            <button
              type="button"
              data-testid="model-chip"
              disabled={!canConfigureModels}
              className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-[12px] text-ink/60 transition-colors hover:bg-[var(--surface-hover)] hover:text-ink/82 disabled:cursor-not-allowed disabled:opacity-60"
              title={label}
              aria-label={label}
            >
              {(loading || saving) && <Loader2 className="h-3 w-3 shrink-0 animate-spin text-ink/40" />}
              {!loading && !saving && currentProvider && (
                <Suspense fallback={null}>
                  <ProviderBadge id={currentProvider.id} name={currentProvider.name} size="xs" />
                </Suspense>
              )}
              <span className="min-w-0 max-w-[120px] truncate">{label}</span>
              {canConfigureModels && <ChevronDown className="h-3 w-3 opacity-60" />}
            </button>
          }
        />
      </Suspense>
    </div>
  );
}
