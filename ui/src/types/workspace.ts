export interface DAGNode {
  id: string;
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  dependencies: string[];
}

export interface TokenBudget {
  used: number;
  total: number;
  percentage: number;
}

export interface ProviderHealth {
  name: string;
  status: "healthy" | "degraded" | "down";
  latency_ms?: number;
}

export interface SubAgent {
  id: string;
  status: "idle" | "running" | "stopped";
  current_task?: string;
  uptime_s: number;
}

export interface ToolExecution {
  id: string;
  tool: string;
  phase: "start" | "end";
  status?: "success" | "error";
  elapsed_ms?: number;
  timestamp: number;
}

export interface ObserverAlert {
  id: string;
  severity: "info" | "warn" | "error";
  message: string;
  timestamp: number;
}

export interface WorkspaceState {
  dag: DAGNode[];
  budget: TokenBudget;
  providers: ProviderHealth[];
  agents: SubAgent[];
  tools: ToolExecution[];
  alerts: ObserverAlert[];
  sessionState: string;
}
