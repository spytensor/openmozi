import { useCallback, useEffect, useState } from "react";
import { useApi } from "@/hooks/useApi";
import type {
  RuntimeHealth,
  RuntimeLogSnapshot,
  RuntimeServiceActionResponse,
  RuntimeServiceStatus,
  RuntimeWorkspaceSnapshot,
} from "@/types/runtime";

interface RuntimeWorkspaceState {
  snapshot: RuntimeWorkspaceSnapshot | null;
  logs: RuntimeLogSnapshot | null;
  health: RuntimeHealth | null;
  service: RuntimeServiceStatus | null;
  loading: boolean;
  serviceBusy: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setServiceEnabled: (enabled: boolean) => Promise<void>;
}

export function useRuntimeWorkspace(enabled: boolean): RuntimeWorkspaceState {
  const { get, post } = useApi();
  const [snapshot, setSnapshot] = useState<RuntimeWorkspaceSnapshot | null>(null);
  const [logs, setLogs] = useState<RuntimeLogSnapshot | null>(null);
  const [health, setHealth] = useState<RuntimeHealth | null>(null);
  const [service, setService] = useState<RuntimeServiceStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [serviceBusy, setServiceBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);

    const [workspaceResult, logsResult, healthResult] = await Promise.all([
      get<RuntimeWorkspaceSnapshot>("/api/runtime/workspace"),
      get<RuntimeLogSnapshot>("/api/runtime/logs?lines=200"),
      get<RuntimeHealth>("/api/health"),
    ]);
    const serviceResult = await get<RuntimeServiceStatus>("/api/runtime/service");

    if (workspaceResult.error || logsResult.error || healthResult.error || serviceResult.error) {
      setError(workspaceResult.error || logsResult.error || healthResult.error || serviceResult.error || "Runtime workspace unavailable");
    }
    setSnapshot(workspaceResult.data);
    setLogs(logsResult.data);
    setHealth(healthResult.data);
    setService(serviceResult.data);
    setLoading(false);
  }, [enabled, get]);

  const setServiceEnabled = useCallback(async (serviceEnabled: boolean) => {
    if (!enabled) return;
    setServiceBusy(true);
    setError(null);
    const result = await post<RuntimeServiceActionResponse>("/api/runtime/service", {
      action: serviceEnabled ? "enable" : "disable",
    });
    if (result.error || !result.data?.ok) {
      setError(result.error || result.data?.error || "Runtime service update failed");
    }
    if (result.data?.status) {
      setService(result.data.status);
    } else {
      const serviceResult = await get<RuntimeServiceStatus>("/api/runtime/service");
      if (serviceResult.error) {
        setError(serviceResult.error);
      }
      setService(serviceResult.data);
    }
    setServiceBusy(false);
  }, [enabled, get, post]);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      setLogs(null);
      setHealth(null);
      setService(null);
      setError(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { snapshot, logs, health, service, loading, serviceBusy, error, refresh, setServiceEnabled };
}
