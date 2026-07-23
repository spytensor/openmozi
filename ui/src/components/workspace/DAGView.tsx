import type { DAGNode } from "@/types/workspace";
import { cn } from "@/lib/utils";

interface DAGViewProps {
  nodes: DAGNode[];
}

const nodeColors: Record<string, string> = {
  pending: "border-white/20 bg-white/5",
  running: "border-accent bg-accent/10",
  completed: "border-success bg-success/10",
  failed: "border-error bg-error/10",
};

export default function DAGView({ nodes }: DAGViewProps) {
  if (nodes.length === 0) {
    return (
      <div>
        <span className="section-header block mb-2">Task DAG</span>
        <p className="text-xs text-white/30">No active tasks</p>
      </div>
    );
  }

  return (
    <div>
      <span className="section-header block mb-2">Task DAG</span>
      <div className="space-y-2">
        {nodes.map((node) => (
          <div
            key={node.id}
            className={cn("px-3 py-2 rounded border text-xs", nodeColors[node.status] || nodeColors.pending)}
          >
            <span className="font-medium">{node.label}</span>
            {node.dependencies.length > 0 && (
              <span className="text-white/30 ml-2">← {node.dependencies.join(", ")}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
