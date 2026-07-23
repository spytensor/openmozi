import type { SubAgent } from "@/types/workspace";
import { formatUptime } from "@/lib/utils";
import { cn } from "@/lib/utils";

interface SubAgentMonitorProps {
  agents: SubAgent[];
}

const statusColors: Record<string, string> = {
  idle: "bg-white/10 text-white/50",
  running: "bg-accent/20 text-accent",
  stopped: "bg-error/20 text-error",
};

export default function SubAgentMonitor({ agents }: SubAgentMonitorProps) {
  if (agents.length === 0) {
    return <p className="text-xs text-white/30 text-center py-4">No active agents</p>;
  }

  return (
    <div className="space-y-2">
      {agents.map((a) => (
        <div key={a.id} className="card-surface p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-white/60">{a.id.slice(0, 8)}</span>
            <span className={cn("badge", statusColors[a.status] || statusColors.idle)}>{a.status}</span>
          </div>
          {a.current_task && <p className="text-xs text-white/50 truncate">{a.current_task}</p>}
          <p className="text-xs text-white/30 mt-1">Up {formatUptime(a.uptime_s)}</p>
        </div>
      ))}
    </div>
  );
}
