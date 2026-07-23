import type { ProviderHealth } from "@/types/workspace";
import { cn } from "@/lib/utils";

interface ProviderStatusProps {
  providers: ProviderHealth[];
}

const dotColors: Record<string, string> = {
  healthy: "bg-success",
  degraded: "bg-warning",
  down: "bg-error",
};

export default function ProviderStatus({ providers }: ProviderStatusProps) {
  return (
    <div>
      <span className="section-header block mb-2">Providers</span>
      {providers.length === 0 ? (
        <p className="text-xs text-white/30">No provider data</p>
      ) : (
        <div className="space-y-1.5">
          {providers.map((p) => (
            <div key={p.name} className="flex items-center gap-2 text-xs">
              <span className={cn("w-2 h-2 rounded-full shrink-0", dotColors[p.status] || dotColors.down)} />
              <span className="text-white/80">{p.name}</span>
              {p.latency_ms != null && <span className="text-white/30 ml-auto">{p.latency_ms}ms</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
