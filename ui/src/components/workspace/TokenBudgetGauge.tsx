import type { TokenBudget } from "@/types/workspace";
import { cn } from "@/lib/utils";

interface TokenBudgetGaugeProps {
  budget: TokenBudget;
}

export default function TokenBudgetGauge({ budget }: TokenBudgetGaugeProps) {
  const pct = budget.total > 0 ? (budget.used / budget.total) * 100 : 0;
  const color = pct < 60 ? "bg-success" : pct < 85 ? "bg-warning" : "bg-error";

  return (
    <div>
      <span className="section-header block mb-2">Token Budget</span>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs text-white/50">{budget.used.toLocaleString()} / {budget.total.toLocaleString()}</span>
        <span className="text-xs font-medium">{pct.toFixed(0)}%</span>
      </div>
      <div className="h-2 bg-white/10 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
