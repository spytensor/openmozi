import { AlertTriangle, Check, Circle, CircleSlash, Loader2, PauseCircle, type LucideIcon } from "lucide-react";
import type { PlanStartedUpdate, TaskUpdate } from "@/types";
import { cn } from "@/lib/utils";
import { useLocale, type MessageKey } from "@/i18n";
import { latestTaskMap } from "./run-metrics";

type DagState = "pending" | "running" | "completed" | "failed" | "blocked" | "cancelled";

interface DagViewProps {
  plan: PlanStartedUpdate;
  tasks: TaskUpdate[];
}

function stateOf(task: TaskUpdate | undefined): DagState {
  const raw = task?.rawStatus?.toLowerCase() ?? "";
  if (raw.includes("cancel")) return "cancelled";
  if (raw.includes("block")) return "blocked";
  // A stale worker `userStatus=blocked` must not relabel a later authoritative
  // task failure after reload. Explicit task status wins unless rawStatus says
  // the dependency/input gate truly blocked.
  if (task?.status === "failed") return "failed";
  if (task?.userStatus === "blocked") return "blocked";
  return task?.status ?? "pending";
}

const STATE_META: Record<DagState, { label: MessageKey; tone: string; Icon: LucideIcon }> = {
  pending: { label: "run.plan.pending", tone: "text-ink/30", Icon: Circle },
  running: { label: "run.plan.running", tone: "text-[color:var(--work-active)]", Icon: Loader2 },
  completed: { label: "run.plan.completed", tone: "text-success/75", Icon: Check },
  failed: { label: "run.plan.failed", tone: "text-danger", Icon: AlertTriangle },
  blocked: { label: "run.plan.blocked", tone: "text-warning", Icon: PauseCircle },
  cancelled: { label: "run.plan.cancelled", tone: "text-ink/34", Icon: CircleSlash },
};

function levelsOf(phases: PlanStartedUpdate["phases"]): Map<string, number> {
  const byId = new Map(phases.map((phase) => [phase.taskId, phase]));
  const levels = new Map<string, number>();
  const visit = (id: string, visiting = new Set<string>()): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    const phase = byId.get(id);
    if (!phase || phase.dependsOn.length === 0) {
      levels.set(id, 0);
      return 0;
    }
    const nextVisiting = new Set(visiting).add(id);
    const level = 1 + Math.max(...phase.dependsOn.map((dependency) => visit(dependency, nextVisiting)));
    levels.set(id, level);
    return level;
  };
  phases.forEach((phase) => visit(phase.taskId));
  return levels;
}

function TaskRow({ phase, task }: { phase: PlanStartedUpdate["phases"][number]; task?: TaskUpdate }) {
  const { t } = useLocale();
  const state = stateOf(task);
  const meta = STATE_META[state];
  const Icon = meta.Icon;
  return (
    <div className="flex min-h-11 items-start gap-2.5 py-2">
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", meta.tone, state === "running" && "animate-spin motion-reduce:animate-none")} strokeWidth={1.8} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-5 text-ink/74">{phase.title}</div>
        <div className={cn("mt-0.5 text-[10.5px]", meta.tone)}>{t(meta.label)}</div>
      </div>
    </div>
  );
}

export default function DagView({ plan, tasks }: DagViewProps) {
  const { t } = useLocale();
  const latest = latestTaskMap(tasks);
  const dependents = new Map<string, number>();
  for (const phase of plan.phases) {
    for (const dependency of phase.dependsOn) dependents.set(dependency, (dependents.get(dependency) ?? 0) + 1);
  }
  const branching = plan.phases.some((phase) => phase.dependsOn.length > 1)
    || [...dependents.values()].some((count) => count > 1);

  if (!branching) {
    return (
      <div className="divide-y divide-ink/[0.06]" data-testid="run-plan-spine">
        {plan.phases.map((phase) => <TaskRow key={phase.taskId} phase={phase} task={latest.get(phase.taskId)} />)}
      </div>
    );
  }

  const levels = levelsOf(plan.phases);
  const columns = new Map<number, typeof plan.phases>();
  for (const phase of plan.phases) {
    const level = levels.get(phase.taskId) ?? 0;
    columns.set(level, [...(columns.get(level) ?? []), phase]);
  }
  const maxLevel = Math.max(0, ...levels.values());
  const maxRows = Math.max(1, ...[...columns.values()].map((items) => items.length));
  const width = Math.max(640, (maxLevel + 1) * 220 + 40);
  const height = Math.max(260, maxRows * 92 + 48);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [level, items] of columns) {
    items.forEach((phase, index) => {
      positions.set(phase.taskId, {
        x: 24 + level * 220,
        y: 24 + ((index + 0.5) * (height - 48)) / items.length - 30,
      });
    });
  }

  return (
    <div data-testid="run-plan-dag">
      <div className="hidden overflow-x-auto rounded-lg border border-ink/[0.07] bg-ink/[0.015] lg:block">
        <svg width={width} height={height} role="img" aria-label={plan.goal}>
          {plan.phases.flatMap((phase) => phase.dependsOn.map((dependency) => {
            const from = positions.get(dependency);
            const to = positions.get(phase.taskId);
            if (!from || !to) return null;
            const startX = from.x + 184;
            const startY = from.y + 30;
            const endX = to.x;
            const endY = to.y + 30;
            const midpoint = (startX + endX) / 2;
            const fromState = stateOf(latest.get(dependency));
            const toState = stateOf(latest.get(phase.taskId));
            const activeEdge = fromState === "running" || toState === "running";
            return (
              <path
                key={`${dependency}:${phase.taskId}`}
                d={`M ${startX} ${startY} C ${midpoint} ${startY}, ${midpoint} ${endY}, ${endX} ${endY}`}
                fill="none"
                className={activeEdge ? "stroke-[color:var(--work-active)]" : "stroke-ink/15"}
                opacity={activeEdge ? 0.72 : 1}
                strokeWidth="1.25"
              />
            );
          }))}
          {plan.phases.map((phase) => {
            const position = positions.get(phase.taskId)!;
            const state = stateOf(latest.get(phase.taskId));
            const meta = STATE_META[state];
            const Icon = meta.Icon;
            return (
              <foreignObject key={phase.taskId} x={position.x} y={position.y} width="184" height="64">
                <div
                  className={cn(
                    "h-[60px] rounded-md border bg-surface px-2.5 py-2 text-left transition-colors duration-200",
                    state === "running" ? "border-[color:var(--work-active)]" :
                      state === "failed" ? "border-danger/55" :
                        state === "blocked" ? "border-warning/55" :
                          state === "completed" ? "border-success/25" : "border-ink/[0.08]",
                  )}
                  style={state === "running" ? { background: "color-mix(in srgb, var(--work-active) 7%, var(--surface-card))" } : undefined}
                >
                  <div className="flex items-center gap-2">
                    <Icon className={cn("h-3.5 w-3.5 shrink-0", meta.tone, state === "running" && "animate-spin motion-reduce:animate-none")} strokeWidth={1.8} aria-hidden="true" />
                    <div className="min-w-0 truncate text-[12px] font-medium text-ink/72" title={phase.title}>{phase.title}</div>
                  </div>
                  <div className={cn("ml-[22px] mt-1 text-[10px]", meta.tone)}>{t(meta.label)}</div>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
      <div className="mt-3 divide-y divide-ink/[0.05] lg:hidden">
        {plan.phases.map((phase) => (
          <div key={phase.taskId}>
            <TaskRow phase={phase} task={latest.get(phase.taskId)} />
            {phase.dependsOn.length > 0 && (
              <div className="-mt-1 pb-2 pl-6 text-[10.5px] text-ink/32">
                {t("run.plan.dependsOn", { names: phase.dependsOn.map((id) => plan.phases.find((item) => item.taskId === id)?.title ?? id).join(", ") })}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
