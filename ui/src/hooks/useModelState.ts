import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useApi } from "@/hooks/useApi";
import {
  applyRoleReadinessToProviders,
  mergeRuntimeProviders,
  type CatalogProvider,
  type ModelRoles,
} from "@/lib/model-catalog";

interface ProvidersResponse {
  providers: CatalogProvider[];
}

export interface ModelState {
  roles: ModelRoles | null;
  providers: CatalogProvider[];
  rolesError: string | null;
  providerError: string | null;
}

interface ModelStateSnapshot {
  data: ModelState | null;
  isPending: boolean;
  isFetching: boolean;
  isError: boolean;
}

const STALE_TIME_MS = 5 * 60_000;
const listeners = new Set<() => void>();
let snapshot: ModelStateSnapshot = { data: null, isPending: true, isFetching: false, isError: false };
let updatedAt = 0;
let inFlight: Promise<{ data: ModelState | null; error: Error | null }> | null = null;

function publish(next: ModelStateSnapshot) {
  snapshot = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type ApiGet = ReturnType<typeof useApi>["get"];

async function loadModelState(get: ApiGet, force = false) {
  if (!force && snapshot.data && Date.now() - updatedAt < STALE_TIME_MS) {
    return { data: snapshot.data, error: null };
  }
  if (inFlight) return inFlight;

  publish({ ...snapshot, isPending: !snapshot.data, isFetching: true, isError: false });
  inFlight = (async () => {
    const [rolesRes, providersRes] = await Promise.all([
      get<ModelRoles>("/api/models/roles"),
      get<ProvidersResponse>("/api/providers"),
    ]);
    const roles = rolesRes.data ?? snapshot.data?.roles ?? null;
    const rolesError = rolesRes.error;
    const providerError = providersRes.error;
    const data: ModelState = {
      roles,
      providers: providersRes.error
        ? snapshot.data?.providers ?? []
        : applyRoleReadinessToProviders(mergeRuntimeProviders(providersRes.data?.providers), roles),
      rolesError,
      providerError,
    };
    const loadError = rolesError || providerError;
    updatedAt = loadError ? 0 : Date.now();
    publish({ data, isPending: false, isFetching: false, isError: !!loadError });
    return { data, error: loadError ? new Error(loadError) : null };
  })().catch((error: unknown) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    publish({ ...snapshot, isPending: false, isFetching: false, isError: true });
    return { data: snapshot.data, error: normalized };
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function setModelState(data: ModelState) {
  updatedAt = Date.now();
  publish({ data, isPending: false, isFetching: false, isError: false });
}

export function clearModelState() {
  updatedAt = 0;
  inFlight = null;
  publish({ data: null, isPending: true, isFetching: false, isError: false });
}

export function resetModelStateForTests() {
  clearModelState();
}

export function useModelState(enabled = true) {
  const { get } = useApi();
  const current = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);

  useEffect(() => {
    if (enabled) void loadModelState(get);
  }, [enabled, get]);

  const refetch = useCallback(() => loadModelState(get, true), [get]);
  return { ...current, refetch };
}
