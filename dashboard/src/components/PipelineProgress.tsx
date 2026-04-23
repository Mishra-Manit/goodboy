/** Dot-and-line pipeline status. `mini` collapses to just the dots. */

import { cn } from "@dashboard/lib/utils";
import { formatDuration } from "@dashboard/lib/format";
import { TASK_KIND_CONFIG, type TaskKind, type TaskStage } from "@dashboard/lib/api";

type DisplayStatus = "pending" | "active" | "complete" | "failed" | "skipped";

interface PipelineProgressProps {
  stages: TaskStage[];
  kind: TaskKind;
  className?: string;
  mini?: boolean;
}

const DOT: Record<DisplayStatus, string> = {
  pending: "bg-text-void",
  active: "bg-accent shadow-[0_0_8px_rgba(212,160,23,0.5)] animate-pulse-soft",
  complete: "bg-ok",
  failed: "bg-fail",
  skipped: "bg-text-void/50",
};

const LABEL: Record<DisplayStatus, string> = {
  pending: "text-text-void",
  active: "text-accent",
  complete: "text-text-dim",
  failed: "text-fail",
  skipped: "text-text-void italic",
};

export function PipelineProgress({ stages, kind, className, mini = false }: PipelineProgressProps) {
  const stageMap = new Map(stages.map((s) => [s.stage, s]));
  const kindConfig = TASK_KIND_CONFIG[kind] ?? TASK_KIND_CONFIG.coding_task;
  const names = [
    ...kindConfig.stages,
    ...(stageMap.has("revision") ? ["revision"] : []),
  ];

  if (mini) {
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        {names.map((name) => (
          <span
            key={name}
            title={name}
            className={cn("h-1.5 w-1.5 rounded-full", DOT[displayStatus(stageMap.get(name))])}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-14", className)}>
      {names.map((name, i) => {
        const stage = stageMap.get(name);
        const status = displayStatus(stage);
        return (
          <div key={name} className="relative flex flex-col items-center gap-1">
            {i > 0 && (
              <span className="absolute right-full top-1 h-px w-14 bg-text-ghost" aria-hidden />
            )}
            <span className={cn("h-2 w-2 rounded-full", DOT[status])} />
            <span
              className={cn(
                "whitespace-nowrap font-mono text-[9px] tracking-wide",
                LABEL[status],
              )}
            >
              {name.replace(/_/g, " ")}
            </span>
            {stage?.completedAt && stage.startedAt && (
              <span className="whitespace-nowrap font-mono text-[8px] text-text-void">
                {formatDuration(stage.startedAt, stage.completedAt)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --- Helpers ---

function displayStatus(stage: TaskStage | undefined): DisplayStatus {
  if (!stage) return "pending";
  if (stage.status === "running") return "active";
  return stage.status;
}
