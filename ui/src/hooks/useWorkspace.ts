import { useState, useCallback } from "react";
import type { WorkspaceState, TokenBudget } from "@/types/workspace";
import type { WSInboundMessage } from "@/types";

const defaultState: WorkspaceState = {
  dag: [],
  budget: { used: 0, total: 0, percentage: 0 },
  providers: [],
  agents: [],
  tools: [],
  alerts: [],
  sessionState: "IDLE",
};

/** Map server workspace_state snapshot to our WorkspaceState shape */
function mapServerSnapshot(msg: Record<string, unknown>): Partial<WorkspaceState> {
  const state = (msg.state ?? msg) as Record<string, unknown>;
  const result: Partial<WorkspaceState> = {};

  if (state.sessionState) result.sessionState = state.sessionState as string;
  if (Array.isArray(state.dag)) result.dag = state.dag;
  if (Array.isArray(state.providers)) result.providers = state.providers;
  if (Array.isArray(state.subAgents)) result.agents = state.subAgents;
  if (Array.isArray(state.agents)) result.agents = state.agents;
  if (Array.isArray(state.tools)) result.tools = state.tools;
  if (Array.isArray(state.alerts)) result.alerts = state.alerts;

  // Map server tokenBudget shape to UI TokenBudget shape
  const tb = state.tokenBudget as Record<string, unknown> | undefined;
  if (tb) {
    const total = (tb.total as number) || 0;
    const used = (tb.used as number) || 0;
    result.budget = {
      total,
      used,
      percentage: total > 0 ? Math.round((used / total) * 100) : 0,
    };
  } else if (state.budget) {
    result.budget = state.budget as TokenBudget;
  }

  return result;
}

export function useWorkspace() {
  const [enabled, setEnabled] = useState(() => {
    return new URLSearchParams(window.location.search).has("diagnostics") ||
      localStorage.getItem("mozi:diagnostics") === "1";
  });
  const [state, setState] = useState<WorkspaceState>(defaultState);

  const handleWSMessage = useCallback((msg: WSInboundMessage) => {
    if (!msg.type.startsWith("workspace_")) return;

    const subType = msg.type.replace("workspace_", "");
    switch (subType) {
      case "state":
        setState((s) => ({ ...s, ...mapServerSnapshot(msg as unknown as Record<string, unknown>) }));
        break;
      case "dag":
        setState((s) => ({ ...s, dag: (msg as Record<string, unknown>).nodes as WorkspaceState["dag"] || s.dag }));
        break;
      case "budget": {
        const raw = msg as Record<string, unknown>;
        const tb = (raw.budget ?? raw) as Record<string, unknown>;
        const total = (tb.total as number) || 0;
        const used = (tb.used as number) || 0;
        setState((s) => ({
          ...s,
          budget: { total, used, percentage: total > 0 ? Math.round((used / total) * 100) : 0 },
        }));
        break;
      }
      case "providers":
        setState((s) => ({ ...s, providers: (msg as Record<string, unknown>).providers as WorkspaceState["providers"] || s.providers }));
        break;
      case "agents":
        setState((s) => ({ ...s, agents: (msg as Record<string, unknown>).agents as WorkspaceState["agents"] || s.agents }));
        break;
      case "tools":
        setState((s) => ({
          ...s,
          tools: [...s.tools, ...((msg as Record<string, unknown>).tools as WorkspaceState["tools"] ?? [])].slice(-50),
        }));
        break;
      case "alert":
        setState((s) => ({
          ...s,
          alerts: [...s.alerts, msg as unknown as WorkspaceState["alerts"][0]].slice(-100),
        }));
        break;
      case "session_state":
        setState((s) => ({ ...s, sessionState: (msg as Record<string, unknown>).sessionState as string || s.sessionState }));
        break;
    }
  }, []);

  const toggle = useCallback(() => {
    setEnabled((e) => {
      const next = !e;
      if (next) localStorage.setItem("mozi:diagnostics", "1");
      else localStorage.removeItem("mozi:diagnostics");
      return next;
    });
  }, []);

  return { enabled, state, handleWSMessage, toggle };
}
