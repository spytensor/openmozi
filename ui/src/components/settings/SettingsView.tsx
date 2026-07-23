import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  Brain,
  Check,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  MoreHorizontal,
  Moon,
  Palette,
  Plug,
  Plus,
  Power,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { setModelState, useModelState } from "@/hooks/useModelState";
import type {
  RuntimeHealth,
  RuntimeBuildInfo,
  RuntimeLogSnapshot,
  RuntimeServiceStatus,
  RuntimeWorkspaceSnapshot,
} from "@/types/runtime";
import RuntimeInspectView from "@/components/inspect/RuntimeInspectView";
import { CapabilityChips } from "@/components/models/ModelPickerMenu";
import { ProviderBadge } from "@/components/models/ProviderBadge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLocale, type Locale, type MessageKey } from "@/i18n";
import { LOCALE_REGISTRY } from "@/i18n/locales";
import { useTheme, type ThemePreference } from "@/theme/ThemeProvider";
import {
  applyRoleReadinessToProviders,
  buildKeyHint,
  findModel,
  modelDisplayName,
  providerBrainEligible,
  providerDisplayName,
  providerLightEligible,
  providerNeedsKey,
  providerSelectable,
  type CatalogModel,
  type CatalogProvider,
  type ModelRoleName,
  type ModelRoles,
} from "@/lib/model-catalog";
import { cn } from "@/lib/utils";
import MemoryPanel from "@/components/memory/MemoryPanel";

interface ApiKeyEntry {
  provider: string;
  key_hint: string | null;
  updated_at?: string;
}

interface ServiceEntry {
  id: string;
  category: string;
  name: string;
  hint: string;
  docsUrl: string;
  supportsFetch: boolean;
  configured: boolean;
}

interface ServicesResponse {
  providers: ServiceEntry[];
  activeSearchProvider: string | null;
}

interface RolesPatchResponse {
  success: boolean;
  roles: ModelRoles;
}

interface QuotaPatchResponse {
  success: boolean;
  quota: {
    tenant_id: string;
    allowed_models: string[];
  };
}

interface LiveModelEntry {
  id: string;
  bundled: boolean;
  resolvable: boolean;
  metadata: {
    contextWindow?: number;
    maxOutputTokens?: number;
    supportsTools?: boolean;
    supportsVision?: boolean;
    inputCostPer1M?: number;
    outputCostPer1M?: number;
  } | null;
}

interface LiveModelsResponse {
  success: boolean;
  provider: string;
  source: "live" | "cache";
  fetched_at: string | null;
  fallback_reason: string | null;
  models: LiveModelEntry[];
}

type CodingWorkerId = "codex_cli" | "claude_code";
type CodingWorkerRouting = "auto" | CodingWorkerId;

interface CodingWorkersResponse {
  workers: Array<{ id: CodingWorkerId; installed: boolean; authed: boolean; ready: boolean;
    commandPath: string | null; remediation: string | null }>;
  config: { routing: CodingWorkerRouting; available: CodingWorkerId[] };
}

type Category = "general" | "models" | "providers" | "memory" | "appearance" | "diagnostics" | "about";

interface SettingsViewProps {
  initialCategory?: Category;
  snapshot?: RuntimeWorkspaceSnapshot | null;
  logs?: RuntimeLogSnapshot | null;
  health?: RuntimeHealth | null;
  service?: RuntimeServiceStatus | null;
  runtimeLoading?: boolean;
  serviceBusy?: boolean;
  error?: string | null;
  onLogout?: () => void;
  onRefreshRuntime?: () => void;
  onSetServiceEnabled?: (enabled: boolean) => void;
  onClose?: () => void;
}

export default function SettingsView({
  initialCategory = "general",
  snapshot = null,
  logs = null,
  health = null,
  service = null,
  runtimeLoading = false,
  serviceBusy = false,
  error = null,
  onLogout,
  onRefreshRuntime,
  onSetServiceEnabled,
  onClose,
}: SettingsViewProps) {
  const { locale, setLocale, t } = useLocale();
  const { preference: themePreference, setPreference: setThemePreference } = useTheme();
  const { get, post, put, patch, del } = useApi();
  const modelState = useModelState();
  const [category, setCategory] = useState<Category>(initialCategory);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [buildInfo, setBuildInfo] = useState<RuntimeBuildInfo | null>(null);
  const [shellVersion, setShellVersion] = useState<string | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  const [roles, setRoles] = useState<ModelRoles | null>(() => modelState.data?.roles ?? null);
  const [providers, setProviders] = useState<CatalogProvider[]>(() => modelState.data?.providers ?? []);
  const [providersLoading, setProvidersLoading] = useState(() => modelState.isPending);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [savingRole, setSavingRole] = useState<ModelRoleName | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [activeModelIds, setActiveModelIds] = useState<Set<string>>(new Set());
  const [savedActiveModelIds, setSavedActiveModelIds] = useState<Set<string>>(new Set());
  const [savingActivation, setSavingActivation] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [refreshingLiveProviders, setRefreshingLiveProviders] = useState<Set<string>>(new Set());

  const [keys, setKeys] = useState<ApiKeyEntry[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [newKey, setNewKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [savingKey, setSavingKey] = useState(false);
  // The add-key form stays collapsed behind a button. Keeping a password input
  // permanently mounted made the browser's password manager autofill the account
  // email into nearby fields; revealing it only on demand avoids that.
  const [showAddKey, setShowAddKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [checking, setChecking] = useState<Set<string>>(new Set());
  const [checkResult, setCheckResult] = useState<Map<string, { ok: boolean; error?: string; model?: string }>>(new Map());

  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [activeSearchProvider, setActiveSearchProvider] = useState<string | null>(null);
  const [showAddServiceKey, setShowAddServiceKey] = useState(false);
  const [selectedServiceId, setSelectedServiceId] = useState("");
  const [newServiceKey, setNewServiceKey] = useState("");
  const [showServiceKey, setShowServiceKey] = useState(false);
  const [savingServiceKey, setSavingServiceKey] = useState(false);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [codingWorkers, setCodingWorkers] = useState<CodingWorkersResponse["workers"]>([]);
  const [codingWorkerConfig, setCodingWorkerConfig] = useState<CodingWorkersResponse["config"]>({ routing: "auto", available: [] });
  const [savedCodingWorkerConfig, setSavedCodingWorkerConfig] = useState<CodingWorkersResponse["config"]>({ routing: "auto", available: [] });
  const [codingWorkersLoading, setCodingWorkersLoading] = useState(true);
  const [codingWorkersSaving, setCodingWorkersSaving] = useState(false);
  const [codingWorkersMessage, setCodingWorkersMessage] = useState<string | null>(null);

  useEffect(() => {
    if (modelState.data) {
      const nextActiveModelIds = activeModelIdsFromProviders(modelState.data.providers);
      setRoles(modelState.data.roles);
      setProviders(modelState.data.providers);
      setActiveModelIds(nextActiveModelIds);
      setSavedActiveModelIds(nextActiveModelIds);
      setSelectedProviderId((previous) => previous || modelState.data.roles?.brain.provider || modelState.data.providers[0]?.id || "");
    }
    setProvidersLoading(modelState.isPending);
    setProvidersError(modelState.data?.providerError || modelState.data?.rolesError || modelState.isError ? t("models.loadError") : null);
  }, [modelState.data, modelState.isError, modelState.isPending, t]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [keyRes, servicesRes, versionRes, codingWorkerRes] = await Promise.all([
        get<{ keys: ApiKeyEntry[] }>("/api/keys"),
        get<ServicesResponse>("/api/services"),
        get<RuntimeBuildInfo>("/api/version"),
        get<CodingWorkersResponse>("/api/coding-workers"),
      ]);
      if (cancelled) return;
      setKeys(keyRes.data?.keys ?? []);
      if (servicesRes.data) {
        setServices(servicesRes.data.providers ?? []);
        setActiveSearchProvider(servicesRes.data.activeSearchProvider ?? null);
      }
      setBuildInfo(versionRes.data ?? null);
      if (codingWorkerRes.data) {
        setCodingWorkers(codingWorkerRes.data.workers);
        setCodingWorkerConfig(codingWorkerRes.data.config);
        setSavedCodingWorkerConfig(codingWorkerRes.data.config);
      } else {
        setCodingWorkersMessage(codingWorkerRes.error ?? t("common.unavailable"));
      }
      setCodingWorkersLoading(false);
      setSelectedProviderId((previous) => previous || keyRes.data?.keys?.[0]?.provider || "");
    })();
    return () => {
      cancelled = true;
    };
  }, [get, t]);

  useEffect(() => {
    let cancelled = false;
    const getDesktopBuildInfo = window.moziDesktop?.getBuildInfo;
    if (!getDesktopBuildInfo) return;
    getDesktopBuildInfo().then((info) => {
      if (!cancelled) setShellVersion(info.version);
    }).catch(() => {
      if (!cancelled) setShellVersion(null);
    });
    return () => { cancelled = true; };
  }, []);

  const keyByProvider = useMemo(() => new Map(keys.map((entry) => [entry.provider, entry])), [keys]);
  const providerById = useMemo(() => new Map(providers.map((provider) => [provider.id, provider])), [providers]);
  const selectedProvider = providerById.get(selectedProviderId) ?? providers[0];
  const sortedProviders = useMemo(() => {
    return [...providers].sort((a, b) => {
      const aConfigured = keyByProvider.has(a.id) || !!a.hasKey;
      const bConfigured = keyByProvider.has(b.id) || !!b.hasKey;
      if (aConfigured !== bConfigured) return aConfigured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [keyByProvider, providers]);

  const brainPickerProviders = useMemo(
    () => providers.filter((provider) => provider.models.length > 0 && providerBrainEligible(provider)),
    [providers],
  );
  const lightPickerProviders = useMemo(
    () => providers.filter((provider) => provider.models.length > 0 && providerLightEligible(provider)),
    [providers],
  );
  const embeddingPickerProviders = useMemo(() => {
    const autoProvider: CatalogProvider = {
      id: "auto",
      name: t("settings.model.embedding.auto"),
      apiMode: "local",
      hasKey: true,
      defaultModel: "auto",
      models: [{ id: "auto", name: t("settings.model.embedding.auto") }],
    };
    const noneProvider: CatalogProvider = {
      id: "none",
      name: t("settings.model.embedding.none"),
      apiMode: "local",
      hasKey: true,
      defaultModel: "none",
      models: [{ id: "none", name: t("settings.model.embedding.none") }],
    };
    const openaiProvider = providerById.get("openai");
    const ollamaProvider = providerById.get("ollama");
    const supported: CatalogProvider[] = [];
    if (openaiProvider) {
      supported.push({
        ...openaiProvider,
        defaultModel: "text-embedding-3-small",
        models: [
          { id: "text-embedding-3-small", name: "text-embedding-3-small" },
          { id: "text-embedding-3-large", name: "text-embedding-3-large" },
        ],
      });
    }
    if (ollamaProvider) {
      supported.push({
        ...ollamaProvider,
        defaultModel: "embeddinggemma",
        models: [
          { id: "embeddinggemma", name: "embeddinggemma" },
          { id: "qwen3-embedding", name: "qwen3-embedding" },
          { id: "all-minilm", name: "all-minilm" },
        ],
      });
    }
    return [autoProvider, ...supported, noneProvider];
  }, [providerById, t]);

  const activationProviders = useMemo(() => {
    return providers
      .filter((provider) => provider.hasKey && provider.models.length > 0)
      .map((provider) => ({
        ...provider,
        models: [...provider.models].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
      }));
  }, [providers]);
  const activationModelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of activationProviders) {
      for (const model of provider.models) ids.add(model.id);
    }
    return ids;
  }, [activationProviders]);
  const bundledActivationModelIds = useMemo(() => {
    const ids = new Set<string>();
    for (const provider of activationProviders) {
      for (const model of provider.models) {
        if (!model.discovered) ids.add(model.id);
      }
    }
    return ids;
  }, [activationProviders]);
  const hasSelectedDiscoveredModels = useMemo(() => {
    for (const provider of activationProviders) {
      for (const model of provider.models) {
        if (model.discovered && activeModelIds.has(model.id)) return true;
      }
    }
    return false;
  }, [activationProviders, activeModelIds]);
  const allActivationModelsChecked = activationModelIds.size > 0
    && Array.from(activationModelIds).every((modelId) => activeModelIds.has(modelId));
  const selectedActivationModelIds = useMemo(
    () => new Set(Array.from(activeModelIds).filter((modelId) => activationModelIds.has(modelId))),
    [activationModelIds, activeModelIds],
  );
  const activationDirty = !setsEqual(selectedActivationModelIds, savedActiveModelIds);

  const refreshProviders = useCallback(async () => {
    setProvidersLoading(true);
    setProvidersError(null);
    const result = await modelState.refetch();
    if (result.error) {
      setProvidersError(t("models.loadError"));
      setProvidersLoading(false);
      return;
    }
    setProvidersLoading(false);
  }, [modelState, t]);

  const toggleActiveModel = (modelId: string, checked: boolean) => {
    setActivationError(null);
    setActiveModelIds((current) => {
      const next = new Set(current);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  };

  const refreshLiveModels = async (providerId: string) => {
    if (refreshingLiveProviders.has(providerId)) return;
    setActivationError(null);
    setRefreshingLiveProviders((current) => new Set(current).add(providerId));
    const { data, error: fetchError } = await get<LiveModelsResponse>(`/api/providers/${providerId}/models/live`);
    setRefreshingLiveProviders((current) => {
      const next = new Set(current);
      next.delete(providerId);
      return next;
    });
    if (!data?.success) {
      setActivationError(fetchError ?? t("common.unavailable"));
      return;
    }
    setProviders((current) => current.map((provider) => {
      if (provider.id !== providerId) return provider;
      const existingIds = new Set(provider.models.map((model) => model.id));
      const existingById = new Map(provider.models.map((model) => [model.id, model]));
      const liveModels = data.models
        .filter((model) => !model.bundled && model.resolvable)
        .map((model): CatalogModel => ({
          ...(existingById.get(model.id) ?? {}),
          id: model.id,
          name: existingById.get(model.id)?.name ?? model.id,
          contextWindow: model.metadata?.contextWindow ?? existingById.get(model.id)?.contextWindow ?? null,
          maxOutputTokens: model.metadata?.maxOutputTokens ?? existingById.get(model.id)?.maxOutputTokens ?? null,
          supportsTools: model.metadata?.supportsTools ?? existingById.get(model.id)?.supportsTools,
          supportsVision: model.metadata?.supportsVision ?? existingById.get(model.id)?.supportsVision,
          inputCostPer1M: model.metadata?.inputCostPer1M ?? existingById.get(model.id)?.inputCostPer1M ?? null,
          outputCostPer1M: model.metadata?.outputCostPer1M ?? existingById.get(model.id)?.outputCostPer1M ?? null,
          allowed: existingById.get(model.id)?.allowed ?? false,
          discovered: true,
          source: data.source,
          capabilityConfidence: model.metadata ? "provider" : "conservative",
        }));
      return {
        ...provider,
        models: provider.apiMode === "cli-pipe"
          ? [
              ...provider.models.filter((model) => !model.discovered),
              ...liveModels,
            ]
          : [
              ...provider.models,
              ...liveModels.filter((model) => !existingIds.has(model.id)),
            ].map((model) => liveModels.find((liveModel) => liveModel.id === model.id) ?? model),
      };
    }));
  };

  const addManualModel = async (providerId: string, modelId: string): Promise<boolean> => {
    const normalized = modelId.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(normalized)) {
      setActivationError(t("settings.models.activation.manualInvalid"));
      return false;
    }
    const { error } = await post(`/api/providers/${providerId}/models/manual`, { model: normalized });
    if (error) {
      setActivationError(error);
      return false;
    }
    setProviders((current) => current.map((provider) => provider.id !== providerId || provider.models.some((model) => model.id === normalized)
      ? provider
      : {
          ...provider,
          models: [...provider.models, {
            id: normalized,
            name: normalized,
            allowed: false,
            discovered: true,
            source: "manual",
            capabilityConfidence: "conservative",
          }],
        }));
    setActiveModelIds((current) => new Set(current).add(normalized));
    setActivationError(null);
    return true;
  };

  const saveActivation = async () => {
    if (savingActivation) return;
    setSavingActivation(true);
    setActivationError(null);
    const selected = Array.from(selectedActivationModelIds);
    const allBundledChecked = bundledActivationModelIds.size > 0
      && Array.from(bundledActivationModelIds).every((modelId) => activeModelIds.has(modelId));
    const allowedModels = allBundledChecked && !hasSelectedDiscoveredModels ? null : selected;
    const { data, error: patchError } = await put<QuotaPatchResponse>("/api/quotas/default", {
      allowed_models: allowedModels,
    });
    setSavingActivation(false);
    if (!data?.success) {
      setActivationError(patchError ?? t("common.unavailable"));
      return;
    }
    const savedIds = new Set(selected);
    const nextProviders = providers.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({
        ...model,
        allowed: allowedModels === null || savedIds.has(model.id),
      })),
    }));
    setProviders(nextProviders);
    setActiveModelIds(savedIds);
    setSavedActiveModelIds(savedIds);
    setModelState({
      roles,
      providers: nextProviders,
      rolesError: modelState.data?.rolesError ?? null,
      providerError: modelState.data?.providerError ?? null,
    });
  };

  const updateRole = async (role: ModelRoleName, provider: CatalogProvider, model: CatalogModel) => {
    if (!model.id || savingRole) return;
    const current = roles?.[role];
    if (current?.provider === provider.id && current.model === model.id) return;
    setSavingRole(role);
    setRoleError(null);
    const payload = role === "embedding"
      ? {
          embedding: {
            provider: provider.id,
            ...(!["auto", "none"].includes(provider.id) ? { model: model.id } : {}),
          },
        }
      : { [role]: { provider: provider.id, model: model.id } };
    const { data, error: patchError } = await patch<RolesPatchResponse>("/api/models/roles", payload);
    setSavingRole(null);
    if (data?.roles) {
      setRoles(data.roles);
      const nextProviders = applyRoleReadinessToProviders(providers, data.roles);
      setProviders(nextProviders);
      setModelState({
        roles: data.roles,
        providers: nextProviders,
        rolesError: null,
        providerError: modelState.data?.providerError ?? null,
      });
      return;
    }
    setRoleError(patchError ?? t("common.unavailable"));
  };

  const inheritRole = async (role: "step" | "plan_summary") => {
    if (savingRole) return;
    setSavingRole(role);
    setRoleError(null);
    const { data, error: patchError } = await patch<RolesPatchResponse>("/api/models/roles", { [role]: null });
    setSavingRole(null);
    if (data?.roles) {
      setRoles(data.roles);
      const nextProviders = applyRoleReadinessToProviders(providers, data.roles);
      setProviders(nextProviders);
      setModelState({ roles: data.roles, providers: nextProviders, rolesError: null, providerError: modelState.data?.providerError ?? null });
      return;
    }
    setRoleError(patchError ?? t("common.unavailable"));
  };

  const modelIdForProvider = (provider: CatalogProvider): string => {
    const matchingRole = roles && Object.values(roles).find((role) => role.provider === provider.id && role.model);
    return matchingRole?.model || provider.defaultModel || provider.models[0]?.id || "";
  };

  const runCheck = async (providerId: string, modelId: string) => {
    if (!providerId || !modelId) return;
    setChecking((prev) => new Set(prev).add(providerId));
    const { data, error: checkError } = await post<{ ok: boolean; error?: string; model?: string }>(`/api/providers/${providerId}/check`, { model: modelId });
    setChecking((prev) => {
      const next = new Set(prev);
      next.delete(providerId);
      return next;
    });
    setCheckResult((prev) => new Map(prev).set(providerId, data ?? { ok: false, error: checkError ?? t("common.unavailable") }));
  };

  const saveKey = async (providerId: string) => {
    const normalized = newKey.trim();
    if (!providerId || !normalized) return;
    setSavingKey(true);
    setKeyError(null);
    const { error: postError } = await post(`/api/keys/${providerId}`, { key: normalized });
    setSavingKey(false);
    if (postError) {
      setKeyError(postError);
      return;
    }
    const hint = buildKeyHint(normalized);
    setKeys((prev) => {
      const rest = prev.filter((entry) => entry.provider !== providerId);
      return [...rest, { provider: providerId, key_hint: hint, updated_at: new Date().toISOString() }];
    });
    setProviders((prev) => prev.map((provider) => (provider.id === providerId ? { ...provider, hasKey: true } : provider)));
    setCheckResult((prev) => {
      const next = new Map(prev);
      next.delete(providerId);
      return next;
    });
    setNewKey("");
    setShowKey(false);
    setShowAddKey(false);
  };

  const removeKey = async (providerId: string) => {
    setKeyError(null);
    const { error: deleteError } = await del(`/api/keys/${providerId}`);
    if (deleteError) {
      setKeyError(deleteError);
      return;
    }
    setKeys((prev) => prev.filter((entry) => entry.provider !== providerId));
    setCheckResult((prev) => {
      const next = new Map(prev);
      next.delete(providerId);
      return next;
    });
    await refreshProviders();
  };

  const refreshServices = async () => {
    const { data } = await get<ServicesResponse>("/api/services");
    if (data) {
      setServices(data.providers ?? []);
      setActiveSearchProvider(data.activeSearchProvider ?? null);
    }
  };

  const saveServiceKey = async (id: string) => {
    if (!newServiceKey.trim()) return;
    setSavingServiceKey(true);
    setServiceError(null);
    const { error } = await post(`/api/services/${id}/key`, { key: newServiceKey.trim() });
    setSavingServiceKey(false);
    if (error) {
      setServiceError(error);
      return;
    }
    setNewServiceKey("");
    setShowAddServiceKey(false);
    setShowServiceKey(false);
    await refreshServices();
  };

  const removeServiceKey = async (id: string) => {
    setServiceError(null);
    const { error } = await del(`/api/services/${id}/key`);
    if (error) {
      setServiceError(error);
      return;
    }
    await refreshServices();
  };

  const setActiveSearch = async (id: string) => {
    setServiceError(null);
    const { error } = await post("/api/services/search/active", { id });
    if (error) {
      setServiceError(error);
      return;
    }
    setActiveSearchProvider(id);
  };

  const searchServices = services.filter((s) => s.category === "search");

  const serviceInstalled = !!service?.installed;
  const serviceEnabled = serviceInstalled && service.enabled;
  const codingWorkersDirty = codingWorkerConfig.routing !== savedCodingWorkerConfig.routing
    || !setsEqual(new Set(codingWorkerConfig.available), new Set(savedCodingWorkerConfig.available));

  const toggleCodingWorker = (id: CodingWorkerId) => {
    setCodingWorkersMessage(null);
    setCodingWorkerConfig((current) => {
      const active = current.available.includes(id);
      return {
        routing: active && current.routing === id ? "auto" : current.routing,
        available: active ? current.available.filter((workerId) => workerId !== id) : [...current.available, id],
      };
    });
  };

  const saveCodingWorkers = async () => {
    setCodingWorkersSaving(true);
    setCodingWorkersMessage(null);
    const { data, error: saveError } = await put<{ config: CodingWorkersResponse["config"] }>("/api/coding-workers", codingWorkerConfig);
    setCodingWorkersSaving(false);
    if (!data) {
      setCodingWorkersMessage(saveError ?? t("common.unavailable"));
      return;
    }
    setCodingWorkerConfig(data.config);
    setSavedCodingWorkerConfig(data.config);
    setCodingWorkersMessage(t("settings.codingWorkers.savedNextTurn"));
  };

  const navItems: { key: Category; label: string; icon: LucideIcon }[] = [
    { key: "general", label: t("settings.nav.general"), icon: Settings2 },
    { key: "models", label: t("settings.nav.models"), icon: Brain },
    { key: "providers", label: t("settings.nav.providers"), icon: KeyRound },
    { key: "memory", label: t("settings.nav.memory"), icon: Database },
    { key: "appearance", label: t("settings.nav.appearance"), icon: Palette },
    { key: "diagnostics", label: t("settings.nav.diagnostics"), icon: Server },
    { key: "about", label: t("settings.nav.about"), icon: Info },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
      data-testid="settings-backdrop"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        tabIndex={-1}
        className="flex h-[min(760px,calc(100vh-2rem))] w-full max-w-[1180px] flex-col overflow-hidden rounded-xl border outline-none"
        style={{ background: "var(--surface-elevated)", borderColor: "rgba(255, 255, 255, 0.04)", boxShadow: "var(--composer-shadow)" }}
      >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: "var(--border-subtle)" }}>
        <div>
          <h1 id="settings-dialog-title" className="text-[22px] font-semibold tracking-normal text-ink/85">{t("settings.title")}</h1>
          <p className="mt-1 max-w-[560px] text-[12.5px] leading-5 text-ink/40">{t("settings.description")}</p>
        </div>
        <div className="flex items-center gap-2">
          {onRefreshRuntime && (
          <button
            type="button"
            onClick={onRefreshRuntime}
            className="flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
            style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
          >
            <Settings2 className="h-3.5 w-3.5" />
            {t("common.refresh")}
          </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t("settings.close")}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink/45 transition-colors hover:bg-ink/[0.05] hover:text-ink/75"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div data-testid="settings-scroll-region" className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        <nav aria-label={t("settings.sections")} className="flex shrink-0 gap-1 overflow-x-auto border-b p-3 md:w-[176px] md:flex-col md:overflow-visible md:border-b-0 md:border-r" style={{ borderColor: "var(--border-subtle)" }}>
          {navItems.map((item) => {
            const active = category === item.key;
            return (
              <button
                key={item.key}
                data-settings-category={item.key}
                aria-current={active ? "page" : undefined}
                onClick={() => setCategory(item.key)}
                className="flex min-h-9 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors"
                style={{
                  background: active ? "var(--surface-active)" : "transparent",
                  color: active ? "var(--text-primary)" : "rgb(var(--ink-rgb) / 0.58)",
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = "var(--surface-hover)";
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = "transparent";
                }}
              >
                <item.icon className="h-4 w-4 shrink-0 opacity-80" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden p-4">
          {category === "general" && (
            <div className="space-y-5">
            <SettingsGroup icon={Settings2} title={t("settings.language.title")} description={t("settings.language.description")}>
              {/* The section header already names the setting — no repeated
                  row label (DESIGN.md: no redundant labeling). */}
              <select
                aria-label={t("settings.language.title")}
                value={locale}
                onChange={(event) => setLocale(event.target.value as Locale)}
                className="rounded-md border px-2.5 py-1.5 text-[13px] outline-none"
                style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
              >
                {LOCALE_REGISTRY.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </SettingsGroup>
            <SettingsGroup icon={Terminal} title={t("settings.codingWorkers.title")} description={t("settings.codingWorkers.description")}>
              {codingWorkersLoading ? (
                <p className="px-1 text-[12px] text-ink/42">{t("common.loading")}</p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-ink/[0.08]">
                  {codingWorkers.map((worker) => {
                    const active = codingWorkerConfig.available.includes(worker.id);
                    return (
                      <div key={worker.id} className="flex min-w-0 items-center gap-3 border-b border-ink/[0.06] px-3 py-2.5 last:border-b-0">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium text-ink/76">{t(`settings.codingWorkers.${worker.id}` as MessageKey)}</span>
                          <span className={cn("mt-0.5 block text-[11px] leading-4", worker.ready ? "text-success" : "text-ink/42")}>
                            {worker.ready
                              ? t("settings.codingWorkers.ready")
                              : worker.installed && !worker.authed
                                ? `${t("settings.codingWorkers.notAuthed")}: ${worker.remediation}`
                                : worker.installed
                                  ? `${t("settings.codingWorkers.notReady")}: ${worker.remediation}`
                                  : t("settings.codingWorkers.notInstalled")}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className={cn("text-[11px] font-medium tabular-nums", active ? "text-activity" : "text-ink/38")}>
                            {active ? t("settings.codingWorkers.activated") : t("settings.codingWorkers.notActivated")}
                          </span>
                          <button
                            type="button"
                            role="switch"
                            data-testid={`settings-coding-worker-${worker.id}`}
                            aria-label={t("settings.codingWorkers.activate", { worker: t(`settings.codingWorkers.${worker.id}` as MessageKey) })}
                            aria-checked={active}
                            disabled={!worker.ready && !active}
                            onClick={() => toggleCodingWorker(worker.id)}
                            className={cn("relative h-5 w-9 rounded-full border transition-colors disabled:opacity-35", active ? "border-activity bg-activity" : "border-ink/20 bg-ink/[0.12]")}
                          >
                            <span aria-hidden className={cn("absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-[left]", active ? "left-[18px]" : "left-[2px]")} />
                          </button>
                        </span>
                      </div>
                    );
                  })}
                  <div className="flex flex-wrap items-center gap-2 border-t border-ink/[0.06] px-3 py-2.5">
                    <label className="text-[11.5px] text-ink/48" htmlFor="coding-worker-routing">{t("settings.codingWorkers.routing")}</label>
                    <select
                      id="coding-worker-routing"
                      value={codingWorkerConfig.routing}
                      onChange={(event) => setCodingWorkerConfig((current) => ({ ...current, routing: event.target.value as CodingWorkerRouting }))}
                      className="h-8 rounded-md border px-2 text-[12px] outline-none"
                      style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                    >
                      <option value="auto">{t("settings.codingWorkers.routingAuto")}</option>
                      <option value="codex_cli" disabled={!codingWorkerConfig.available.includes("codex_cli")}>Codex CLI</option>
                      <option value="claude_code" disabled={!codingWorkerConfig.available.includes("claude_code")}>Claude Code</option>
                    </select>
                    <button
                      type="button"
                      data-testid="settings-save-coding-workers"
                      disabled={!codingWorkersDirty || codingWorkersSaving}
                      onClick={() => void saveCodingWorkers()}
                      className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[11.5px] font-medium disabled:opacity-45"
                      style={{ background: "var(--action)", color: "var(--action-fg)" }}
                    >
                      {codingWorkersSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      {t("settings.codingWorkers.save")}
                    </button>
                  </div>
                </div>
              )}
              {codingWorkersMessage && <p className="px-1 text-[11.5px] leading-4 text-ink/48">{codingWorkersMessage}</p>}
            </SettingsGroup>
            </div>
          )}
          {category === "models" && (
            <div className="space-y-3">
              <ProviderLoadStatus
                loading={providersLoading}
                error={providersError}
                onRetry={() => void refreshProviders()}
              />
              <SettingsGroup icon={SlidersHorizontal} title={t("settings.model.rolesTitle")} description={t("settings.model.rolesDescription")}>
                <div data-testid="settings-role-grid" className="settings-role-grid grid gap-3">
                  <RoleSlotCard
                    role="brain"
                    title={t("settings.model.role.brain")}
                    description={t("settings.model.role.brainDesc")}
                    roles={roles}
                    providers={providers}
                    pickerProviders={brainPickerProviders}
                    saving={savingRole === "brain"}
                    onSelect={updateRole}
                  />
                  <RoleSlotCard
                    role="light"
                    title={t("settings.model.role.light")}
                    description={t("settings.model.role.lightDesc")}
                    roles={roles}
                    providers={providers}
                    pickerProviders={lightPickerProviders}
                    saving={savingRole === "light"}
                    onSelect={updateRole}
                  />
                  <RoleSlotCard
                    role="step"
                    title={t("settings.model.role.step")}
                    description={t("settings.model.role.stepDesc")}
                    roles={roles}
                    providers={providers}
                    pickerProviders={brainPickerProviders}
                    saving={savingRole === "step"}
                    allowInherit
                    onInherit={() => void inheritRole("step")}
                    onSelect={updateRole}
                  />
                  <RoleSlotCard
                    role="plan_summary"
                    title={t("settings.model.role.planSummary")}
                    description={t("settings.model.role.planSummaryDesc")}
                    roles={roles}
                    providers={providers}
                    pickerProviders={brainPickerProviders}
                    saving={savingRole === "plan_summary"}
                    allowInherit
                    onInherit={() => void inheritRole("plan_summary")}
                    onSelect={updateRole}
                  />
                  <RoleSlotCard
                    role="embedding"
                    title={t("settings.model.role.embedding")}
                    description={t("settings.model.role.embeddingDesc")}
                    roles={roles}
                    providers={providers}
                    pickerProviders={embeddingPickerProviders}
                    saving={savingRole === "embedding"}
                    onSelect={updateRole}
                  />
                </div>
                {roleError && (
                  <div className="mx-2 mb-2 flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-2 text-[12px] text-warning">
                    <AlertCircle className="h-3.5 w-3.5" />
                    {roleError}
                  </div>
                )}
              </SettingsGroup>
              <SettingsGroup icon={ShieldCheck} title={t("settings.models.activation.title")} description={t("settings.models.activation.description")}>
                <ActiveModelsBlock
                  providers={activationProviders}
                  activeModelIds={activeModelIds}
                  allActive={allActivationModelsChecked}
                  dirty={activationDirty}
                  saving={savingActivation}
                  error={activationError}
                  refreshingProviderIds={refreshingLiveProviders}
                  onToggle={toggleActiveModel}
                  onRefreshLive={refreshLiveModels}
                  onAddManual={addManualModel}
                  onSave={saveActivation}
                />
              </SettingsGroup>
            </div>
          )}

          {category === "providers" && (
            <div className="space-y-4">
              <ProviderLoadStatus
                loading={providersLoading}
                error={providersError}
                onRetry={() => void refreshProviders()}
              />
              <SettingsGroup>
                <div className="space-y-3 p-2">
                  {!showAddKey ? (
                    <button
                      onClick={() => setShowAddKey(true)}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors hover:bg-ink/[0.04]"
                      style={{ borderColor: "var(--border-medium)", color: "var(--text-primary)" }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("settings.keys.addButton")}
                    </button>
                  ) : (
                  <form
                    autoComplete="off"
                    onSubmit={(e) => { e.preventDefault(); if (selectedProvider) void saveKey(selectedProvider.id); }}
                    className="flex flex-col gap-2 rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3 lg:flex-row lg:items-end"
                  >
                    <label className="min-w-[180px] flex-1">
                      <span className="mb-1 block text-[11px] text-ink/38">{t("settings.keys.provider")}</span>
                      <select
                        value={selectedProvider?.id ?? ""}
                        onChange={(event) => setSelectedProviderId(event.target.value)}
                        className="h-9 w-full rounded-md border px-2.5 text-[12.5px] outline-none"
                        style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                      >
                        {providers.map((provider) => (
                          <option key={provider.id} value={provider.id}>{provider.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="min-w-[240px] flex-[2]">
                      <span className="mb-1 block text-[11px] text-ink/38">{t("settings.keys.add")}</span>
                      <span className="relative block">
                        <input
                          type={showKey ? "text" : "password"}
                          name="provider-api-key"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          data-1p-ignore
                          data-lpignore="true"
                          data-form-type="other"
                          value={newKey}
                          onChange={(event) => setNewKey(event.target.value)}
                          placeholder={selectedProvider && keyByProvider.has(selectedProvider.id) ? t("settings.provider.replaceKey") : t("settings.keys.placeholder")}
                          className="h-9 w-full rounded-md border px-2.5 pr-9 font-mono text-[12.5px] outline-none"
                          style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowKey((value) => !value)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-ink/40 hover:text-ink/70"
                        >
                          {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </span>
                    </label>
                    <button
                      type="submit"
                      disabled={!selectedProvider || !newKey.trim() || savingKey}
                      className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
                      style={{ background: "var(--action)", color: "var(--action-fg)" }}
                    >
                      {savingKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      {t("settings.keys.save")}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowAddKey(false); setNewKey(""); }}
                      className="inline-flex h-9 shrink-0 items-center justify-center rounded-md px-3 text-[12.5px] transition-colors hover:bg-ink/[0.04]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {t("settings.keys.cancel")}
                    </button>
                  </form>
                  )}
                  {keyError && <div className="flex items-center gap-1.5 text-[11.5px] text-warning"><AlertCircle className="h-3.5 w-3.5" />{keyError}</div>}
                  <div className="overflow-hidden rounded-lg border border-ink/[0.06]">
                    {sortedProviders.length === 0 ? (
                      <div className="px-4 py-8 text-center text-[12.5px] text-ink/35">{t("settings.provider.noResults")}</div>
                    ) : (
                      sortedProviders.map((provider) => (
                        <ProviderKeyRow
                          key={provider.id}
                          provider={provider}
                          keyEntry={keyByProvider.get(provider.id)}
                          check={checkResult.get(provider.id)}
                          checking={checking.has(provider.id)}
                          canTest={providerSelectable(provider) && !!modelIdForProvider(provider)}
                          canRemove={keyByProvider.has(provider.id)}
                          modelId={modelIdForProvider(provider)}
                          onSelect={() => setSelectedProviderId(provider.id)}
                          onTest={() => runCheck(provider.id, modelIdForProvider(provider))}
                          onRemove={() => removeKey(provider.id)}
                        />
                      ))
                    )}
                  </div>
                </div>
              </SettingsGroup>
            </div>
          )}

          {category === "providers" && (
            <div className="space-y-4">
              <p className="px-1 text-[12.5px] leading-5 text-ink/45">{t("settings.services.description")}</p>

              <SettingsGroup icon={Search} title={t("settings.services.search.title")} description={t("settings.services.search.description")}>
                <div className="space-y-3 p-2">
                  {!showAddServiceKey ? (
                    <button
                      onClick={() => { setShowAddServiceKey(true); if (!selectedServiceId) setSelectedServiceId(searchServices[0]?.id ?? ""); }}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium transition-colors hover:bg-ink/[0.04]"
                      style={{ borderColor: "var(--border-medium)", color: "var(--text-primary)" }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      {t("settings.services.addButton")}
                    </button>
                  ) : (
                    <form
                      autoComplete="off"
                      onSubmit={(e) => { e.preventDefault(); if (selectedServiceId) void saveServiceKey(selectedServiceId); }}
                      className="flex flex-col gap-2 rounded-lg border border-ink/[0.06] bg-ink/[0.018] p-3 lg:flex-row lg:items-end"
                    >
                      <label className="min-w-[180px] flex-1">
                        <span className="mb-1 block text-[11px] text-ink/38">{t("settings.services.provider")}</span>
                        <select
                          value={selectedServiceId || searchServices[0]?.id || ""}
                          onChange={(event) => setSelectedServiceId(event.target.value)}
                          className="h-9 w-full rounded-md border px-2.5 text-[12.5px] outline-none"
                          style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                        >
                          {searchServices.map((svc) => (
                            <option key={svc.id} value={svc.id}>{svc.name}</option>
                          ))}
                        </select>
                      </label>
                      <label className="min-w-[240px] flex-[2]">
                        <span className="mb-1 block text-[11px] text-ink/38">{t("settings.keys.add")}</span>
                        <span className="relative block">
                          <input
                            type={showServiceKey ? "text" : "password"}
                            name="service-api-key"
                            autoComplete="off"
                            autoCorrect="off"
                            autoCapitalize="off"
                            spellCheck={false}
                            data-1p-ignore
                            data-lpignore="true"
                            data-form-type="other"
                            value={newServiceKey}
                            onChange={(event) => setNewServiceKey(event.target.value)}
                            placeholder={t("settings.keys.placeholder")}
                            className="h-9 w-full rounded-md border px-2.5 pr-9 font-mono text-[12.5px] outline-none"
                            style={{ background: "var(--surface-input)", borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
                          />
                          <button
                            type="button"
                            onClick={() => setShowServiceKey((value) => !value)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink/40 hover:text-ink/70"
                          >
                            {showServiceKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                          </button>
                        </span>
                      </label>
                      <button
                        type="submit"
                        disabled={!selectedServiceId || !newServiceKey.trim() || savingServiceKey}
                        className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50"
                        style={{ background: "var(--action)", color: "var(--action-fg)" }}
                      >
                        {savingServiceKey ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        {t("settings.keys.save")}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setShowAddServiceKey(false); setNewServiceKey(""); }}
                        className="inline-flex h-9 shrink-0 items-center justify-center rounded-md px-3 text-[12.5px] transition-colors hover:bg-ink/[0.04]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {t("settings.keys.cancel")}
                      </button>
                    </form>
                  )}
                  {serviceError && <div className="flex items-center gap-1.5 text-[11.5px] text-warning"><AlertCircle className="h-3.5 w-3.5" />{serviceError}</div>}
                  <div className="overflow-hidden rounded-lg border border-ink/[0.06]">
                    {searchServices.map((svc) => (
                      <ServiceProviderRow
                        key={svc.id}
                        service={svc}
                        active={activeSearchProvider === svc.id}
                        onSetActive={() => setActiveSearch(svc.id)}
                        onRemove={() => removeServiceKey(svc.id)}
                      />
                    ))}
                  </div>
                </div>
              </SettingsGroup>

              <SettingsGroup icon={Plug} title={t("settings.services.upcoming.title")} description={t("settings.services.upcoming.description")} />
            </div>
          )}

          {category === "memory" && <MemoryPanel />}

          {category === "appearance" && (
            <>
              <SettingsGroup icon={Palette} title={t("settings.appearance.theme")}>
                <div className="grid gap-2 p-2 sm:grid-cols-3">
                  <ThemeOptionCard
                    preference="system"
                    label={t("settings.appearance.system")}
                    selected={themePreference === "system"}
                    onSelect={setThemePreference}
                  />
                  <ThemeOptionCard
                    preference="light"
                    label={t("settings.appearance.light")}
                    selected={themePreference === "light"}
                    onSelect={setThemePreference}
                  />
                  <ThemeOptionCard
                    preference="dark"
                    label={t("settings.appearance.dark")}
                    selected={themePreference === "dark"}
                    onSelect={setThemePreference}
                  />
                </div>
              </SettingsGroup>

            </>
          )}

          {category === "diagnostics" && (
            <>
              <SettingsGroup icon={Power} title={t("settings.service.title")} description={t("settings.service.description")}>
                <Row label={t("settings.service.currentDaemon")}>
                  <StatusDot tone={health?.ok ? "success" : "muted"} label={health?.ok ? t("settings.service.daemonRunning") : t("settings.service.daemonUnavailable")} />
                </Row>
                <Row label={t("settings.service.background")}>
                  {onSetServiceEnabled && service?.platform !== "unsupported" ? (
                    <button
                      onClick={() => onSetServiceEnabled(!serviceEnabled)}
                      disabled={!service || serviceBusy}
                      className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors disabled:opacity-60"
                      style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
                    >
                      {serviceBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                      {serviceEnabled ? t("settings.service.disable") : t("settings.service.enable")}
                    </button>
                  ) : (
                    <StatusDot tone={serviceEnabled ? "success" : "muted"} label={serviceInstalled ? (serviceEnabled ? t("common.enabled") : t("common.disabled")) : t("inspect.health.backgroundNotInstalled")} />
                  )}
                </Row>
              </SettingsGroup>

              <SettingsGroup icon={Server} title={t("settings.advanced.title")} description={t("settings.advanced.description")}>
                <button
                  data-testid="settings-diagnostics-toggle"
                  onClick={() => setDiagnosticsOpen((value) => !value)}
                  className="inline-flex h-8 items-center gap-2 rounded-md px-3 text-[12.5px] transition-colors"
                  style={{ background: "var(--surface-input)", border: "1px solid var(--border-subtle)", color: "var(--text-secondary)" }}
                >
                  {diagnosticsOpen ? t("inspect.diagnostics.hide") : t("inspect.diagnostics.show")}
                </button>
                {diagnosticsOpen && (
                  <div className="mt-3">
                    <RuntimeInspectView
                      embedded
                      snapshot={snapshot}
                      logs={logs}
                      health={health}
                      service={service}
                      loading={runtimeLoading}
                      serviceBusy={serviceBusy}
                      error={error}
                      onRefresh={onRefreshRuntime ?? (() => {})}
                      onSetServiceEnabled={onSetServiceEnabled ?? (() => {})}
                    />
                  </div>
                )}
              </SettingsGroup>
            </>
          )}

          {category === "about" && (
            <AboutMoziPanel buildInfo={buildInfo} shellVersion={shellVersion} />
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function AboutMoziPanel({ buildInfo, shellVersion }: { buildInfo: RuntimeBuildInfo | null; shellVersion: string | null }) {
  const { t } = useLocale();
  const mismatch = !!shellVersion && !!buildInfo && shellVersion !== buildInfo.version;
  const surface = buildInfo?.surface ?? (shellVersion ? "desktop" : "source");
  const updateDescription = surface === "desktop"
    ? t("settings.about.update.desktop")
    : surface === "docker"
      ? t("settings.about.update.docker")
      : t("settings.about.update.source");

  return (
    <div className="space-y-4" data-testid="settings-about">
      <SettingsGroup icon={Info} title={t("settings.about.title")} description={t("settings.about.description")}>
        <Row label={t("settings.about.version")}>
          <span className="font-mono text-[12.5px] text-ink/72">{buildInfo?.version ?? t("common.unavailable")}</span>
        </Row>
        {shellVersion && (
          <Row label={t("settings.about.shellVersion")}>
            <span className="font-mono text-[12.5px] text-ink/72">{shellVersion}</span>
          </Row>
        )}
        <Row label={t("settings.about.commit")}>
          <span className="font-mono text-[12px] text-ink/58">{buildInfo?.commit?.slice(0, 12) ?? t("common.unavailable")}</span>
        </Row>
        <Row label={t("settings.about.channel")}>
          <span className="text-[12.5px] text-ink/65">{buildInfo ? t(`settings.about.channel.${buildInfo.channel}` as MessageKey) : t("common.unavailable")}</span>
        </Row>
        <Row label={t("settings.about.surface")}>
          <span className="text-[12.5px] text-ink/65">{t(`settings.about.surface.${surface}` as MessageKey)}</span>
        </Row>
        {mismatch && (
          <div data-testid="settings-version-mismatch" className="mx-1 mt-2 flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 px-3 py-2 text-[12px] leading-5 text-warning">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("settings.about.mismatch")}
          </div>
        )}
      </SettingsGroup>
      <SettingsGroup icon={RefreshCw} title={t("settings.about.update.title")} description={updateDescription}>
        <p className="px-1 text-[12px] leading-5 text-ink/45">{t("settings.about.update.notAutomatic")}</p>
      </SettingsGroup>
    </div>
  );
}

function ThemeOptionCard({
  preference,
  label,
  selected,
  onSelect,
}: {
  preference: ThemePreference;
  label: string;
  selected: boolean;
  onSelect: (preference: ThemePreference) => void;
}) {
  const Icon = preference === "system" ? Monitor : preference === "light" ? Sun : Moon;
  return (
    <button
      type="button"
      data-testid={`settings-theme-${preference}`}
      aria-pressed={selected}
      onClick={() => onSelect(preference)}
      className={cn(
        "rounded-lg border p-2 text-left transition-colors",
        selected
          ? "border-selection bg-selection/5 ring-1 ring-selection/80"
          : "border-ink/[0.08] bg-ink/[0.015] hover:border-ink/[0.18] hover:bg-ink/[0.025]",
      )}
    >
      <ThemePreview preference={preference} />
      <span className="mt-2 flex items-center gap-1.5 text-[12.5px] font-medium text-ink/78">
        <Icon className="h-3.5 w-3.5 text-ink/48" />
        {label}
      </span>
    </button>
  );
}

function ThemePreview({ preference }: { preference: ThemePreference }) {
  if (preference === "system") {
    return (
      <div className="grid h-20 overflow-hidden rounded-md border border-ink/[0.08] bg-surface">
        <div className="grid grid-cols-2">
          <ThemePreviewScene mode="dark" />
          <ThemePreviewScene mode="light" />
        </div>
      </div>
    );
  }
  return (
    <div className="h-20 overflow-hidden rounded-md border border-ink/[0.08] bg-surface">
      <ThemePreviewScene mode={preference} />
    </div>
  );
}

function ThemePreviewScene({ mode }: { mode: "light" | "dark" }) {
  const light = mode === "light";
  const palette = light
    ? {
        bg: "#ffffff",
        sidebar: "#f1f3f5",
        surface: "#ffffff",
        border: "rgba(31,41,55,0.12)",
        primary: "rgba(23,25,28,0.82)",
        muted: "rgba(102,112,133,0.42)",
        action: "#8b5e2f",
      }
    : {
        bg: "#111318",
        sidebar: "#14171c",
        surface: "#1b1f25",
        border: "rgba(255,255,255,0.08)",
        primary: "rgba(255,255,255,0.78)",
        muted: "rgba(255,255,255,0.28)",
        action: "#be9157",
      };

  return (
    <div className="flex h-full min-w-0" style={{ background: palette.bg }}>
      <div className="h-full w-[28%]" style={{ background: palette.sidebar }} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
        <div className="h-1.5 w-12 rounded-full" style={{ background: palette.primary }} />
        <div className="h-1.5 w-16 rounded-full" style={{ background: palette.muted }} />
        <div className="mt-1 rounded-md border p-1.5" style={{ background: palette.surface, borderColor: palette.border }}>
          <div className="h-1.5 w-10 rounded-full" style={{ background: palette.primary }} />
          <div className="mt-1 h-1.5 w-14 rounded-full" style={{ background: palette.muted }} />
        </div>
        <div className="mt-auto h-2 w-9 rounded-full" style={{ background: palette.action }} />
      </div>
    </div>
  );
}

function activeModelIdsFromProviders(providers: CatalogProvider[]): Set<string> {
  const ids = new Set<string>();
  for (const provider of providers) {
    if (!provider.hasKey) continue;
    for (const model of provider.models) {
      if (model.allowed !== false) ids.add(model.id);
    }
  }
  return ids;
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && Array.from(left).every((value) => right.has(value));
}

function ProviderLoadStatus({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-warning/20 bg-warning/10 px-3 py-2 text-[12px] leading-5 text-warning">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1">{error}</span>
        <button type="button" onClick={onRetry} className="inline-flex shrink-0 items-center gap-1 underline underline-offset-4">
          <RefreshCw className="h-3 w-3" />
          {t("common.retry")}
        </button>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-ink/[0.06] bg-ink/[0.018] px-3 py-2 text-[12.5px] text-ink/44">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }
  return null;
}

function ActiveModelsBlock({
  providers,
  activeModelIds,
  allActive,
  dirty,
  saving,
  error,
  refreshingProviderIds,
  onToggle,
  onRefreshLive,
  onAddManual,
  onSave,
}: {
  providers: CatalogProvider[];
  activeModelIds: Set<string>;
  allActive: boolean;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  refreshingProviderIds: Set<string>;
  onToggle: (modelId: string, checked: boolean) => void;
  onRefreshLive: (providerId: string) => void;
  onAddManual: (providerId: string, modelId: string) => Promise<boolean>;
  onSave: () => void;
}) {
  const { t } = useLocale();
  const [searchQuery, setSearchQuery] = useState("");
  const [manualModelIds, setManualModelIds] = useState<Record<string, string>>({});
  const [manualProviderId, setManualProviderId] = useState<string | null>(null);
  const [providerSearchQueries, setProviderSearchQueries] = useState<Record<string, string>>({});
  useEffect(() => {
    if (manualProviderId && !providers.some((provider) => provider.id === manualProviderId)) {
      setManualProviderId(null);
    }
  }, [manualProviderId, providers]);

  const selectedCount = useMemo(() => providers.reduce(
    (count, provider) => count + provider.models.filter((model) => activeModelIds.has(model.id)).length,
    0,
  ), [activeModelIds, providers]);
  const filteredProviders = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return providers;
    return providers
      .map((provider) => ({
        ...provider,
        models: provider.models.filter((model) => [
          provider.id,
          provider.name,
          model.id,
          model.name,
        ].some((value) => value?.toLocaleLowerCase().includes(query))),
      }))
      .filter((provider) => provider.models.length > 0);
  }, [providers, searchQuery]);
  const catalogCount = useMemo(
    () => providers.reduce((total, provider) => total + provider.models.length, 0),
    [providers],
  );
  const searching = searchQuery.trim().length > 0;

  const renderModelGrid = (provider: CatalogProvider, models: CatalogModel[]) => (
    <div className="grid grid-cols-1 lg:grid-cols-2">
      {models.map((model, index) => {
        const active = activeModelIds.has(model.id);
        const displayName = model.name || model.id;
        return (
          <button
            key={`${provider.id}:${model.id}`}
            type="button"
            role="switch"
            data-testid={`settings-active-model-${model.id}`}
            aria-checked={active}
            onClick={() => onToggle(model.id, !active)}
            className={cn(
              "group flex min-h-[58px] min-w-0 items-center gap-3 border-ink/[0.06] px-3 py-2 text-left transition-colors hover:bg-ink/[0.025]",
              index > 1 && "lg:border-t",
              index > 0 && "max-lg:border-t",
              index % 2 === 1 && "lg:border-l",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[12px] font-medium text-ink/72" title={model.id}>{displayName}</span>
                {model.discovered && (
                  <span className="shrink-0 rounded border border-selection/20 bg-selection/10 px-1 py-px text-[9px] font-medium text-selection">
                    {model.source === "cache" ? t("model.capability.cached") : model.source === "manual" ? t("model.capability.manual") : t("model.capability.live")}
                  </span>
                )}
              </span>
              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] leading-4 text-ink/34">
                {displayName !== model.id && <span className="truncate font-mono" title={model.id}>{model.id}</span>}
                <CapabilityChips model={model} compact />
                {(model.inputCostPer1M != null || model.outputCostPer1M != null) && (
                  <span className="whitespace-nowrap tabular-nums">${model.inputCostPer1M ?? "?"}/${model.outputCostPer1M ?? "?"}</span>
                )}
              </span>
            </span>
            <span
              aria-hidden
              className={cn(
                "relative h-[18px] w-8 shrink-0 rounded-full border transition-colors",
                active ? "border-selection bg-selection" : "border-ink/14 bg-ink/[0.06]",
              )}
            >
              <span className={cn(
                "absolute top-[2px] h-3 w-3 rounded-full bg-white shadow-sm transition-transform",
                active ? "translate-x-[16px]" : "translate-x-[2px]",
              )} />
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <div className="space-y-3">
      {providers.length === 0 ? (
        <div className="rounded-lg border border-ink/[0.06] bg-ink/[0.018] px-3 py-4 text-center text-[12.5px] text-ink/35">
          {t("settings.noProviders")}
        </div>
      ) : (
        <div
          data-testid="settings-active-model-manager"
          className="overflow-hidden rounded-xl border border-ink/[0.08] bg-ink/[0.012]"
        >
          <div className="flex min-w-0 flex-col gap-2.5 border-b border-ink/[0.07] px-3 py-3 lg:flex-row lg:items-center">
            <div className="min-w-0 flex-1">
              <div className="text-[12.5px] font-semibold text-ink/72">
                {allActive
                  ? t("settings.models.activation.allActive")
                  : t("settings.models.activation.activeCount", { count: selectedCount })}
              </div>
              <div className="mt-0.5 text-[10.5px] text-ink/36">
                {t("settings.models.activation.catalogCount", { count: catalogCount })}
              </div>
            </div>
            <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-ink/[0.08] bg-ink/[0.018] px-2.5 lg:w-[280px]">
              <Search className="h-3.5 w-3.5 shrink-0 text-ink/34" />
              <input
                data-testid="settings-search-active-models"
                aria-label={t("settings.models.activation.searchPlaceholder")}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t("settings.models.activation.searchPlaceholder")}
                className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink/72 outline-none placeholder:text-ink/30"
              />
              {searchQuery && (
                <button
                  type="button"
                  aria-label={t("common.clear")}
                  onClick={() => setSearchQuery("")}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink/34 hover:bg-ink/[0.05] hover:text-ink/60"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <button
              type="button"
              data-testid="settings-save-active-models"
              onClick={onSave}
              disabled={saving || !dirty}
              className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md px-3 text-[11.5px] font-medium transition-colors disabled:opacity-50"
              style={{ background: "var(--action)", color: "var(--action-fg)" }}
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {saving
                ? t("settings.models.activation.saving")
                : dirty
                  ? t("settings.models.activation.save")
                  : t("settings.models.activation.saved")}
            </button>
          </div>

          <div className="divide-y divide-ink/[0.07]">
            {filteredProviders.length === 0 ? (
              <div className="px-3 py-10 text-center text-[12px] text-ink/38">
                {t("settings.models.activation.noResults")}
              </div>
            ) : filteredProviders.map((provider) => {
              const catalogProvider = providers.find((candidate) => candidate.id === provider.id) ?? provider;
              const selectedModels = catalogProvider.models.filter((model) => activeModelIds.has(model.id));
              const availableModels = catalogProvider.models.filter((model) => !activeModelIds.has(model.id));
              const providerSearchQuery = providerSearchQueries[provider.id]?.trim().toLocaleLowerCase() ?? "";
              const pickerModels = providerSearchQuery
                ? availableModels.filter((model) => [model.id, model.name].some((value) => value?.toLocaleLowerCase().includes(providerSearchQuery)))
                : availableModels;
              const providerSelectedCount = selectedModels.length;
              const manualOpen = manualProviderId === provider.id;
              return (
                <section key={provider.id} data-testid={`settings-active-provider-${provider.id}`}>
                  <div className="flex min-w-0 items-center gap-2.5 bg-ink/[0.016] px-3 py-2.5">
                    <ProviderBadge id={provider.id} name={provider.name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-baseline gap-2">
                        <h3 className="truncate text-[12.5px] font-semibold text-ink/76">{provider.name}</h3>
                        <span className="shrink-0 text-[10.5px] tabular-nums text-ink/34">
                          {t("settings.models.activation.providerCount", {
                            active: providerSelectedCount,
                            total: catalogProvider.models.length,
                          })}
                        </span>
                      </div>
                      {provider.hasKey && provider.discovery?.fallback_reason && (
                        <div className="mt-0.5 text-[10px] text-warning/78">
                          {provider.discovery.source === "cache"
                            ? t("settings.models.activation.cachedFallback")
                            : t("settings.models.activation.catalogFallback")}
                        </div>
                      )}
                    </div>
                    {availableModels.length > 0 && (
                      <Popover onOpenChange={(open) => {
                        if (!open) {
                          setProviderSearchQueries((current) => ({ ...current, [provider.id]: "" }));
                        }
                      }}>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            data-testid={`settings-add-model-${provider.id}`}
                            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-ink/[0.08] px-2 text-[10.5px] font-medium text-ink/52 transition-colors hover:bg-ink/[0.04] hover:text-ink/72"
                          >
                            <Plus className="h-3 w-3" />
                            {t("settings.models.activation.addFromCatalog", { count: availableModels.length })}
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[460px] max-w-[calc(100vw-32px)] p-0">
                          <div className="border-b border-ink/[0.07] p-2.5">
                            <div className="flex h-8 items-center gap-2 rounded-md border border-ink/[0.08] bg-ink/[0.018] px-2.5">
                              <Search className="h-3.5 w-3.5 shrink-0 text-ink/34" />
                              <input
                                autoFocus
                                data-testid={`settings-search-provider-models-${provider.id}`}
                                aria-label={t("settings.models.activation.providerSearchPlaceholder", { provider: provider.name })}
                                value={providerSearchQueries[provider.id] ?? ""}
                                onChange={(event) => setProviderSearchQueries((current) => ({ ...current, [provider.id]: event.target.value }))}
                                placeholder={t("settings.models.activation.providerSearchPlaceholder", { provider: provider.name })}
                                className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink/72 outline-none placeholder:text-ink/30"
                              />
                            </div>
                          </div>
                          <div className="max-h-[360px] overflow-y-auto p-1.5">
                            {pickerModels.length === 0 ? (
                              <div className="px-3 py-8 text-center text-[11.5px] text-ink/38">
                                {t("settings.models.activation.noResults")}
                              </div>
                            ) : pickerModels.map((model) => {
                              const displayName = model.name || model.id;
                              return (
                                <button
                                  key={`${provider.id}:picker:${model.id}`}
                                  type="button"
                                  role="switch"
                                  data-testid={`settings-picker-model-${model.id}`}
                                  aria-checked="false"
                                  onClick={() => onToggle(model.id, true)}
                                  className="group flex min-h-[50px] w-full min-w-0 items-center gap-3 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-ink/[0.04]"
                                >
                                  <span className="min-w-0 flex-1">
                                    <span className="flex min-w-0 items-center gap-1.5">
                                      <span className="truncate text-[11.5px] font-medium text-ink/72" title={model.id}>{displayName}</span>
                                      {model.discovered && (
                                        <span className="shrink-0 rounded border border-selection/20 bg-selection/10 px-1 py-px text-[9px] font-medium text-selection">
                                          {model.source === "cache" ? t("model.capability.cached") : model.source === "manual" ? t("model.capability.manual") : t("model.capability.live")}
                                        </span>
                                      )}
                                    </span>
                                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5 text-[9.5px] leading-4 text-ink/34">
                                      {displayName !== model.id && <span className="truncate font-mono" title={model.id}>{model.id}</span>}
                                      <CapabilityChips model={model} compact />
                                    </span>
                                  </span>
                                  <Plus className="h-3.5 w-3.5 shrink-0 text-ink/34 group-hover:text-action" />
                                </button>
                              );
                            })}
                          </div>
                        </PopoverContent>
                      </Popover>
                    )}
                    <button
                      type="button"
                      aria-label={`${t("settings.models.activation.fetchLive")} · ${provider.name}`}
                      title={t("settings.models.activation.fetchLive")}
                      data-testid={`settings-refresh-live-${provider.id}`}
                      onClick={() => onRefreshLive(provider.id)}
                      disabled={refreshingProviderIds.has(provider.id)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/38 transition-colors hover:bg-ink/[0.05] hover:text-ink/65 disabled:opacity-50"
                    >
                      <RefreshCw className={cn("h-3.5 w-3.5", refreshingProviderIds.has(provider.id) && "animate-spin")} />
                    </button>
                    {provider.apiMode !== "cli-pipe" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            aria-label={`${t("common.more")} · ${provider.name}`}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink/38 transition-colors hover:bg-ink/[0.05] hover:text-ink/65"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onSelect={() => setManualProviderId(manualOpen ? null : provider.id)}>
                            <Plus className="mr-2 h-3.5 w-3.5" />
                            {t("settings.models.activation.addCustom")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>

                  {manualOpen && (
                    <div className="flex min-w-0 items-center gap-2 border-t border-ink/[0.06] bg-ink/[0.01] px-3 py-2">
                      <input
                        autoFocus
                        value={manualModelIds[provider.id] ?? ""}
                        onChange={(event) => setManualModelIds((current) => ({ ...current, [provider.id]: event.target.value }))}
                        placeholder={t("settings.models.activation.manualPlaceholder")}
                        className="h-8 min-w-0 flex-1 rounded-md border border-ink/[0.08] bg-transparent px-2.5 font-mono text-[11px] text-ink/70 outline-none focus:border-focus/45"
                      />
                      <button
                        type="button"
                        onClick={async () => {
                          const added = await onAddManual(provider.id, manualModelIds[provider.id] ?? "");
                          if (added) {
                            setManualModelIds((current) => ({ ...current, [provider.id]: "" }));
                            setManualProviderId(null);
                          }
                        }}
                        className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-ink/[0.08] px-2.5 text-[11.5px] font-medium text-ink/58 hover:bg-ink/[0.035]"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        {t("settings.models.activation.registerCustom")}
                      </button>
                    </div>
                  )}

                  {searching ? (
                    renderModelGrid(provider, provider.models)
                  ) : (
                    selectedModels.length > 0 ? renderModelGrid(catalogProvider, selectedModels) : null
                  )}
                </section>
              );
            })}
          </div>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2.5 py-2 text-[12px] text-warning">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}
    </div>
  );
}

function RoleSlotCard({
  role,
  title,
  description,
  roles,
  providers,
  pickerProviders,
  saving,
  allowInherit = false,
  onInherit,
  onSelect,
}: {
  role: ModelRoleName;
  title: string;
  description: string;
  roles: ModelRoles | null;
  providers: CatalogProvider[];
  pickerProviders: CatalogProvider[];
  saving: boolean;
  allowInherit?: boolean;
  onInherit?: () => void;
  onSelect: (role: ModelRoleName, provider: CatalogProvider, model: CatalogModel) => void;
}) {
  const { t } = useLocale();
  const slot = roles?.[role];
  const inherited = Boolean(slot?.inherit);
  const model = slot && !inherited ? findModel(providers, slot.provider, slot.model) : undefined;
  const name = inherited
    ? t("settings.model.inheritConversation")
    : slot
    ? role === "embedding" && ["auto", "none"].includes(slot.provider)
      ? providerDisplayName(pickerProviders, slot.provider)
      : modelDisplayName(role === "embedding" ? pickerProviders : providers, slot.provider, slot.model)
    : t("common.loading");
  const provider = inherited
    ? t("settings.model.inheritConversationDesc")
    : slot ? providerDisplayName(role === "embedding" ? pickerProviders : providers, slot.provider) : t("common.loading");
  const displayProviders = role === "embedding" ? pickerProviders : providers;
  const selectedProvider = slot && !inherited
    ? displayProviders.find((candidate) => candidate.id === slot.provider)
    : undefined;
  const selectableProviders = pickerProviders
    .filter((candidate) => providerSelectable(candidate))
    .map((candidate) => ({
      ...candidate,
      models: candidate.models.filter((candidateModel) => candidateModel.allowed !== false),
    }))
    .filter((candidate) => candidate.models.length > 0);

  return (
    <article data-testid={`settings-role-card-${role}`} className="flex min-h-[152px] flex-col rounded-lg border border-ink/[0.07] bg-ink/[0.018] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[13.5px] font-semibold text-ink/82">{title}</h3>
          <p className="mt-0.5 text-[11.5px] leading-4 text-ink/38">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <StatusDot tone={slot?.ready ? "success" : "muted"} compact label={slot?.ready ? t("common.ready") : t("common.unavailable")} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid={`settings-role-actions-${role}`}
                aria-label={`${title} · ${t("settings.model.actions")}`}
                disabled={!slot || saving}
                className="flex h-7 w-7 items-center justify-center rounded-md text-ink/40 transition-colors hover:bg-ink/[0.05] hover:text-ink/68 disabled:opacity-45"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              className="min-w-[190px] rounded-lg border border-ink/[0.10] bg-elevated p-1 text-ink shadow-[0_20px_60px_-28px_rgba(0,0,0,0.72)]"
            >
              <DropdownMenuSub>
                <DropdownMenuSubTrigger
                  data-testid={`settings-change-role-${role}`}
                  disabled={!slot || saving || selectableProviders.length === 0}
                  className="cursor-pointer rounded-md px-2 py-2 text-[12px] text-ink/72 focus:bg-ink/[0.06]"
                >
                  {t("settings.model.change")}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-[340px] w-[300px] overflow-y-auto rounded-lg border border-ink/[0.10] bg-elevated p-1 text-ink shadow-[0_24px_70px_-28px_rgba(0,0,0,0.72)]">
                  {selectableProviders.map((providerOption, providerIndex) => (
                    <div key={providerOption.id}>
                      {providerIndex > 0 && <DropdownMenuSeparator className="mx-2 my-1 bg-ink/[0.06]" />}
                      <DropdownMenuLabel className="flex items-center gap-2 px-2 py-1 text-[10.5px] font-medium text-ink/42">
                        <ProviderBadge id={providerOption.id} name={providerOption.name} size="xs" />
                        <span className="truncate">{providerOption.name}</span>
                      </DropdownMenuLabel>
                      {providerOption.models.map((modelOption) => {
                        const active = slot?.provider === providerOption.id && slot.model === modelOption.id;
                        return (
                          <DropdownMenuItem
                            key={`${providerOption.id}:${modelOption.id}`}
                            data-model-option={`${providerOption.id}:${modelOption.id}`}
                            onSelect={() => onSelect(role, providerOption, modelOption)}
                            className="mx-1 flex h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] text-ink/76 focus:bg-ink/[0.06] focus:text-ink"
                          >
                            <span className="min-w-0 flex-1 truncate" title={modelOption.id}>{modelOption.name || modelOption.id}</span>
                            {active && <Check className="h-3.5 w-3.5 shrink-0 text-selection" />}
                          </DropdownMenuItem>
                        );
                      })}
                    </div>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {allowInherit && !inherited && (
                <DropdownMenuItem
                  data-testid={`settings-inherit-role-${role}`}
                  disabled={!slot || saving}
                  onSelect={onInherit}
                  className="cursor-pointer rounded-md px-2 py-2 text-[12px] text-ink/72 focus:bg-ink/[0.06]"
                >
                  {t("settings.model.useConversation")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="mt-4 flex min-w-0 items-center gap-2">
        {selectedProvider && <ProviderBadge id={selectedProvider.id} name={selectedProvider.name} size="xs" />}
        <div className="min-w-0 flex-1 truncate text-[15px] font-semibold text-ink/86" title={provider && provider !== name ? `${provider} · ${name}` : name}>
          {name}
        </div>
      </div>
      <div className="mt-auto min-h-[20px] pt-2.5">
        <CapabilityChips model={model} />
      </div>
    </article>
  );
}

function ProviderKeyRow({
  provider,
  keyEntry,
  check,
  checking,
  canTest,
  canRemove,
  modelId,
  onSelect,
  onTest,
  onRemove,
}: {
  provider: CatalogProvider;
  keyEntry?: ApiKeyEntry;
  check?: { ok: boolean; error?: string };
  checking: boolean;
  canTest: boolean;
  canRemove: boolean;
  modelId: string;
  onSelect: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  const masked = keyEntry?.key_hint
    ?? (provider.hasKey ? t("settings.keys.configuredOutsideUi") : t("settings.keys.notSet"));
  const providerCanUseKey = !providerNeedsKey(provider) || !!provider.hasKey;
  return (
    <div
      data-testid={`settings-provider-row-${provider.id}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 border-b border-ink/[0.045] px-3 py-2.5 last:border-b-0 md:grid-cols-[minmax(180px,1fr)_minmax(140px,220px)_auto] md:items-center"
    >
      <button type="button" onClick={onSelect} className="flex min-w-0 items-center gap-2 text-left">
        <ConnectivityDot check={check} checking={checking} />
        <ProviderBadge id={provider.id} name={provider.name} />
        <span className="min-w-0">
          <span className="block truncate text-[13px] font-medium text-ink/78">{provider.name}</span>
          <span className="block truncate text-[10.5px] text-ink/34">{provider.hint ?? provider.apiMode}</span>
        </span>
      </button>
      <div className="min-w-0 truncate font-mono text-[11.5px] text-ink/45 md:text-left" title={masked}>
        {masked}
      </div>
      <div className="col-span-2 flex justify-end gap-2 md:col-span-1">
        <button
          data-testid={`settings-test-provider-${provider.id}`}
          onClick={onTest}
          disabled={!canTest || checking || !providerCanUseKey}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors disabled:opacity-45"
          style={{ background: "var(--surface-input)", border: "1px solid rgb(var(--ink-rgb) / 0.08)", color: "var(--text-secondary)" }}
          title={modelId}
        >
          {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {t("settings.model.test")}
        </button>
        <button
          onClick={onRemove}
          disabled={!canRemove}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors disabled:opacity-35"
          style={{ background: "var(--surface-input)", border: "1px solid rgb(var(--ink-rgb) / 0.08)", color: "var(--text-secondary)" }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          {t("settings.keys.remove")}
        </button>
      </div>
      {check && !check.ok && check.error && (
        <div className="col-span-2 truncate text-[11px] text-warning md:col-span-3" title={check.error}>
          {check.error}
        </div>
      )}
    </div>
  );
}

function ServiceProviderRow({
  service,
  active,
  onSetActive,
  onRemove,
}: {
  service: ServiceEntry;
  active: boolean;
  onSetActive: () => void;
  onRemove: () => void;
}) {
  const { t } = useLocale();
  return (
    <div
      data-testid={`settings-service-row-${service.id}`}
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-ink/[0.045] px-3 py-2.5 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold uppercase"
          style={{ background: "rgb(var(--ink-rgb) / 0.06)", color: "var(--text-secondary)" }}
        >
          {service.name.charAt(0)}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px] font-medium text-ink/78">{service.name}</span>
            {active && <span className="badge bg-selection/15 text-selection">{t("settings.services.active")}</span>}
          </span>
          <span className="block truncate text-[10.5px] text-ink/34">{service.hint}</span>
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        {service.configured ? (
          <>
            {!active && (
              <button
                data-testid={`settings-service-activate-${service.id}`}
                onClick={onSetActive}
                className="inline-flex h-8 items-center rounded-md px-2.5 text-[12px] transition-colors hover:bg-ink/[0.04]"
                style={{ border: "1px solid rgb(var(--ink-rgb) / 0.08)", color: "var(--text-secondary)" }}
              >
                {t("settings.services.setActive")}
              </button>
            )}
            <span className="badge shrink-0 bg-success/15 text-success">{t("settings.services.configured")}</span>
            <button
              data-testid={`settings-service-remove-${service.id}`}
              onClick={onRemove}
              className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] transition-colors"
              style={{ background: "var(--surface-input)", border: "1px solid rgb(var(--ink-rgb) / 0.08)", color: "var(--text-secondary)" }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("settings.keys.remove")}
            </button>
          </>
        ) : (
          <a
            href={service.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[12px] text-link transition-colors hover:bg-ink/[0.04] hover:text-link-hover"
          >
            {t("settings.services.getKey")}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

function ConnectivityDot({ check, checking }: { check?: { ok: boolean }; checking: boolean }) {
  const { t } = useLocale();
  if (checking) return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-ink/40" />;
  const label = check ? (check.ok ? t("settings.provider.testPassed") : t("settings.provider.testFailed")) : t("common.unknown");
  const color = check ? (check.ok ? "var(--success)" : "var(--danger)") : "rgb(var(--ink-rgb) / 0.24)";
  return <span aria-label={label} title={label} className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />;
}

function SettingsGroup({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: LucideIcon;
  title?: string;
  description?: string;
  children?: ReactNode;
}) {
  // Flat section: the header sits on the page ground and only genuinely
  // interactive content carries card chrome. Wrapping every section in a
  // bordered box put a card around cards (Models/Appearance) and billboarded
  // near-empty tabs (DESIGN.md: no billboard empty states, no card-in-card).
  return (
    <section className="flex flex-col gap-3">
      {title && (
        <div className="flex items-start gap-2.5">
          {Icon && <Icon className="mt-[3px] h-4 w-4 flex-shrink-0 text-ink/45" />}
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold leading-5 text-ink/80">{title}</h2>
            {description && <p className="mt-0.5 text-[12px] leading-5 text-ink/38">{description}</p>}
          </div>
        </div>
      )}
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg px-2.5 py-2">
      <span className="min-w-0 truncate text-[12.5px] text-ink/55">{label}</span>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function StatusDot({ tone, label, compact = false }: { tone: "success" | "danger" | "muted"; label: string; compact?: boolean }) {
  const color = tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : "rgb(var(--ink-rgb) / 0.24)";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap ${compact ? "text-[11px]" : "text-[12.5px]"} text-ink/55`}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}
