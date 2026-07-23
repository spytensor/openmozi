import type { ObserverAlert } from "@/types/workspace";
import { formatRelativeTime } from "@/lib/utils";
import { Info, AlertTriangle, XCircle } from "lucide-react";

interface ObserverAlertsProps {
  alerts: ObserverAlert[];
}

const icons = {
  info: Info,
  warn: AlertTriangle,
  error: XCircle,
};

const colors = {
  info: "text-accent",
  warn: "text-warning",
  error: "text-error",
};

export default function ObserverAlerts({ alerts }: ObserverAlertsProps) {
  if (alerts.length === 0) {
    return <p className="text-xs text-white/30 text-center py-4">No alerts</p>;
  }

  return (
    <div className="space-y-1">
      {[...alerts].reverse().map((a) => {
        const Icon = icons[a.severity] || Info;
        return (
          <div key={a.id} className="flex items-start gap-2 px-2 py-2 text-xs hover:bg-white/[0.03] rounded">
            <Icon size={14} className={`${colors[a.severity] || colors.info} shrink-0 mt-0.5`} />
            <div className="flex-1 min-w-0">
              <p className="text-white/80">{a.message}</p>
              <p className="text-white/30 mt-0.5">{formatRelativeTime(a.timestamp)}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
