import MODEL_CATALOG_JSON from "@/data/model-catalog.generated.json";

export interface CatalogModel {
  id: string;
  name: string;
  tier?: "high" | "mid" | "low";
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  supportsTools?: boolean;
  supportsVision?: boolean;
  reasoning?: boolean;
  inputCostPer1M?: number | null;
  outputCostPer1M?: number | null;
  allowed?: boolean;
  discovered?: boolean;
  source?: "live" | "cache" | "catalog" | "manual";
  capabilityConfidence?: "provider" | "catalog" | "conservative";
}

export interface CatalogProvider {
  id: string;
  name: string;
  hint?: string | null;
  defaultModel?: string;
  apiMode?: string;
  apiType?: string;
  brainEligible?: boolean;
  lightEligible?: boolean;
  embeddingEligible?: boolean;
  hasKey?: boolean;
  discovery?: {
    supported: boolean;
    source: "live" | "cache" | "catalog";
    fetched_at: string | null;
    capability_confidence: "provider" | "catalog" | "conservative";
    fallback_reason: string | null;
  };
  models: CatalogModel[];
}

export interface ModelRoleSlot {
  provider: string;
  model: string;
  ready: boolean;
  eligible?: boolean;
  inherit?: boolean;
  configured?: {
    provider: string;
    model: string;
    eligible: false;
    reason: string;
  };
}

export type ModelRoles = {
  brain: ModelRoleSlot;
  light: ModelRoleSlot;
  step: ModelRoleSlot;
  plan_summary: ModelRoleSlot;
  embedding: ModelRoleSlot;
};

export type ModelRoleName = keyof ModelRoles;

export const MODEL_CATALOG = (MODEL_CATALOG_JSON as { providers: CatalogProvider[] }).providers;

const BUNDLED_BY_ID = new Map(MODEL_CATALOG.map((provider) => [provider.id, provider]));

function mergeModels(providerId: string, models: CatalogModel[] | undefined): CatalogModel[] {
  const bundled = BUNDLED_BY_ID.get(providerId);
  const bundledById = new Map((bundled?.models ?? []).map((model) => [model.id, model]));
  if (!models?.length) return bundled?.models ?? [];
  return models.map((model) => ({ ...(bundledById.get(model.id) ?? {}), ...model }));
}

export function mergeRuntimeProviders(runtimeProviders: CatalogProvider[] | undefined | null): CatalogProvider[] {
  if (!runtimeProviders?.length) {
    return MODEL_CATALOG.map((provider) => ({ ...provider, hasKey: false }));
  }
  return runtimeProviders.map((provider) => {
    const bundled = BUNDLED_BY_ID.get(provider.id);
    return {
      ...(bundled ?? {}),
      ...provider,
      apiMode: provider.apiMode ?? provider.apiType ?? bundled?.apiMode,
      models: mergeModels(provider.id, provider.models),
    };
  });
}

export function applyRoleReadinessToProviders(
  providers: CatalogProvider[],
  roles: ModelRoles | null | undefined,
): CatalogProvider[] {
  if (!roles) return providers;
  const readyByProvider = new Map<string, boolean>();
  for (const role of Object.values(roles)) {
    if (role.provider && role.ready) readyByProvider.set(role.provider, true);
  }
  return providers.map((provider) => ({
    ...provider,
    hasKey: provider.hasKey || readyByProvider.get(provider.id) || false,
  }));
}

export function findProvider(providers: CatalogProvider[], providerId: string): CatalogProvider | undefined {
  return providers.find((provider) => provider.id === providerId) ?? BUNDLED_BY_ID.get(providerId);
}

export function findModel(
  providers: CatalogProvider[],
  providerId: string,
  modelId: string,
): CatalogModel | undefined {
  return findProvider(providers, providerId)?.models.find((model) => model.id === modelId);
}

export function modelDisplayName(
  providers: CatalogProvider[],
  providerId: string,
  modelId: string,
): string {
  return findModel(providers, providerId, modelId)?.name || modelId || providerId;
}

export function providerDisplayName(providers: CatalogProvider[], providerId: string): string {
  return findProvider(providers, providerId)?.name || providerId;
}

export function providerNeedsKey(provider: CatalogProvider): boolean {
  return provider.id !== "auto" && provider.id !== "none" && provider.apiMode !== "cli-pipe";
}

export function providerSelectable(provider: CatalogProvider): boolean {
  if (provider.apiMode === "cli-pipe" || provider.apiType === "cli-pipe") return !!provider.hasKey;
  return !providerNeedsKey(provider) || !!provider.hasKey;
}

export function providerBrainEligible(provider: CatalogProvider): boolean {
  return provider.brainEligible !== false;
}

export function providerLightEligible(provider: CatalogProvider): boolean {
  return provider.lightEligible !== false;
}

export function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export function buildKeyHint(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}
