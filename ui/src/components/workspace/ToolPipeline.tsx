import type { ToolExecution } from "@/types/workspace";
import { formatDuration, formatRelativeTime } from "@/lib/utils";
import { Loader2, Check, X } from "lucide-react";

interface ToolPipelineProps {
  executions: ToolExecution[];
}

export default function ToolPipeline({ executions }: ToolPipelineProps) {
  if (executions.length === 0) {
    return <p className="text-xs text-white/30 text-center py-4">No tool executions</p>;
  }

  return (
    <div className="space-y-1">
      {executions.map((e) => (
        <div key={e.id} className="flex items-center gap-2 px-2 py-1.5 text-xs hover:bg-white/[0.03] rounded">
          {e.phase === "start" ? (
            <Loader2 size={12} className="text-accent animate-spin shrink-0" />
          ) : e.status === "error" ? (
            <X size={12} className="text-error shrink-0" />
          ) : (
            <Check size={12} className="text-success shrink-0" />
          )}
          <span className="font-mono text-accent">{e.tool}</span>
          {e.elapsed_ms != null && <span className="text-white/30 ml-auto">{formatDuration(e.elapsed_ms)}</span>}
        </div>
      ))}
    </div>
  );
}
