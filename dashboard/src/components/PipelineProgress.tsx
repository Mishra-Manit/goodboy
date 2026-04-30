/** Dot-and-line pipeline status. `mini` collapses to just the dots. */

import { cn } from "@dashboard/lib/utils";
import { formatDuration } from "@dashboard/lib/format";
import { TASK_KIND_CONFIG, type TaskKind, type TaskStage } from "@dashboard/lib/api";
import { displayStatus, rollupStages, type DisplayStatus } from "@dashboard/lib/pipeline-progress";

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
  mixed: "bg-warn",
};

const LABEL: Record<DisplayStatus, string> = {
  pending: "text-text-void",
  active: "text-accent",
  complete: "text-text-dim",
  failed: "text-fail",
  skipped: "text-text-void italic",
  mixed: "text-warn",
};

export function PipelineProgress({ stages, kind, className, mini = false }: PipelineProgressProps) {
  const stageRollups = rollupStages(stages);
  const kindConfig = TASK_KIND_CONFIG[kind] ?? TASK_KIND_CONFIG.coding_task;
  const names = [
    ...kindConfig.stages,
    ...(stageRollups.has("revision") ? ["revision" as const] : []),
  ];

  if (mini) {
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        {names.map((name) => (
          <span
            key={name}
            title={name}
            className={cn("h-1.5 w-1.5 rounded-full", DOT[stageRollups.get(name)?.status ?? "pending"])}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn("flex items-start gap-14", className)}>
      {names.map((name, i) => {
        const rollup = stageRollups.get(name);
        const status = rollup?.status ?? "pending";
        return (
          <div key={name} className="relative flex flex-col items-center gap-1">
            {i > 0 && (
              <span className="absolute right-full top-1 h-px w-14 bg-text-ghost" aria-hidden />
            )}
            {rollup && rollup.rows.length > 1 ? (
              <span className="flex gap-0.5">
                {rollup.rows.map((stage) => (
                  <span
                    key={`${stage.stage}#${stage.variant ?? "main"}`}
                    className={cn("h-1.5 w-1.5 rounded-full", DOT[displayStatus(stage)])}
                    title={`pr impact${stage.variant === null ? "" : ` v${stage.variant}`}: ${stage.status}`}
                  />
                ))}
              </span>
            ) : (
              <span className={cn("h-2 w-2 rounded-full", DOT[status])} />
            )}
            <span
              className={cn(
                "whitespace-nowrap font-mono text-[9px] tracking-wide",
                LABEL[status],
              )}
            >
              {name.replace(/_/g, " ")}
            </span>
            {rollup?.startedAt && rollup.completedAt && (
              <span className="whitespace-nowrap font-mono text-[8px] text-text-void">
                {formatDuration(rollup.startedAt, rollup.completedAt)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
