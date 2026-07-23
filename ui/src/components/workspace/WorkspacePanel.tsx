import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { WorkspaceState } from "@/types/workspace";
import DAGView from "./DAGView";
import TokenBudgetGauge from "./TokenBudgetGauge";
import ProviderStatus from "./ProviderStatus";
import SubAgentMonitor from "./SubAgentMonitor";
import ToolPipeline from "./ToolPipeline";
import ObserverAlerts from "./ObserverAlerts";
import { cn } from "@/lib/utils";

interface WorkspacePanelProps {
  state: WorkspaceState;
}

type Tab = "brain" | "agents" | "tools" | "observer";

export default function WorkspacePanel({ state }: WorkspacePanelProps) {
  const [tab, setTab] = useState<Tab>("brain");
  const errorCount = (state.alerts ?? []).filter((a) => a.severity === "error").length;

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "brain", label: "Brain" },
    { id: "agents", label: "Agents" },
    { id: "tools", label: "Tools" },
    { id: "observer", label: "Observer", badge: errorCount || undefined },
  ];

  return (
    <motion.div
      data-testid="workspace-panel"
      initial={{ x: 340 }}
      animate={{ x: 0 }}
      exit={{ x: 340 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-y-0 right-0 z-30 flex w-[340px] flex-col overflow-hidden border-l border-white/[0.06] bg-surface"
    >
      {/* Tabs */}
      <div className="flex border-b border-white/[0.06]">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              "flex-1 px-2 py-2.5 text-xs font-medium relative transition-colors",
              tab === t.id ? "text-white" : "text-white/40 hover:text-white/60"
            )}
          >
            {t.label}
            {t.badge != null && t.badge > 0 && (
              <span className="ml-1 badge bg-error/20 text-error text-[10px] px-1.5">{t.badge}</span>
            )}
            {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent" />}
          </button>
        ))}
      </div>

      {/* Content */}
      <div data-testid="workspace-panel-scroll-region" className="flex-1 overflow-y-auto p-3 space-y-3">
        {tab === "brain" && (
          <>
            <DAGView nodes={state.dag ?? []} />
            <TokenBudgetGauge budget={state.budget ?? { used: 0, total: 0, percentage: 0 }} />
            <ProviderStatus providers={state.providers ?? []} />
          </>
        )}
        {tab === "agents" && <SubAgentMonitor agents={state.agents ?? []} />}
        {tab === "tools" && <ToolPipeline executions={state.tools ?? []} />}
        {tab === "observer" && <ObserverAlerts alerts={state.alerts ?? []} />}
      </div>
    </motion.div>
  );
}
