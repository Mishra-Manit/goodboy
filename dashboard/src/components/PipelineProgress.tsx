import { cn } from "@dashboard/lib/utils";
import type { TaskStage } from "@dashboard/lib/api";

const PIPELINE_STAGES = [
  { key: "planner", label: "Plan" },
  { key: "implementer", label: "Implement" },
  { key: "reviewer", label: "Review" },
  { key: "pr_creator", label: "PR" },
] as const;

interface PipelineProgressProps {
  stages: TaskStage[];
  className?: string;
  mini?: boolean;
}

type DisplayStatus = "pending" | "active" | "complete" | "failed";

function getStatus(stage: TaskStage | undefined): DisplayStatus {
  if (!stage) return "pending";
  if (stage.status === "complete") return "complete";
  if (stage.status === "failed") return "failed";
  if (stage.status === "running") return "active";
  return "pending";
}

const DOT_STYLES: Record<DisplayStatus, string> = {
  pending: "bg-text-void",
  active: "bg-accent shadow-[0_0_8px_rgba(212,160,23,0.5)]",
  complete: "bg-ok",
  failed: "bg-fail",
};

const LINE_STYLES: Record<DisplayStatus, string> = {
  pending: "bg-text-void",
  active: "bg-text-ghost",
  complete: "bg-text-ghost",
  failed: "bg-text-ghost",
};

const LABEL_STYLES: Record<DisplayStatus, string> = {
  pending: "text-text-void",
  active: "text-accent",
  complete: "text-text-dim",
  failed: "text-fail",
};

export function PipelineProgress({
  stages,
  className,
  mini = false,
}: PipelineProgressProps) {
  const stageMap = new Map(stages.map((s) => [s.stage, s]));
  const hasRevision = stageMap.has("revision");

  const allStages = [
    ...PIPELINE_STAGES,
    ...(hasRevision ? [{ key: "revision" as const, label: "Revision" }] : []),
  ];

  if (mini) {
    return (
      <div className={cn("flex items-center gap-1.5", className)}>
        {allStages.map((ps) => {
          const status = getStatus(stageMap.get(ps.key));
          return (
            <div
              key={ps.key}
              title={ps.label}
              className={cn(
                "h-1.5 w-1.5 rounded-full transition-all",
                DOT_STYLES[status],
                status === "active" && "animate-pulse-soft"
              )}
            />
          );
        })}
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-0", className)}>
      {allStages.map((ps, i) => {
        const status = getStatus(stageMap.get(ps.key));
        const stageData = stageMap.get(ps.key);

        return (
          <div key={ps.key} className="flex items-center">
            {/* Connector line -- uses previous stage's status */}
            {i > 0 && (
              <div className={cn("h-px w-6", LINE_STYLES[getStatus(stageMap.get(allStages[i - 1].key))])} />
            )}

            {/* Stage dot + label */}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "h-2 w-2 rounded-full transition-all",
                  DOT_STYLES[status],
                  status === "active" && "animate-pulse-soft"
                )}
              />
              <span
                className={cn(
                  "font-mono text-[9px] tracking-wide",
                  LABEL_STYLES[status]
                )}
              >
                {ps.label}
              </span>
              {stageData?.completedAt && stageData.startedAt && (
                <span className="font-mono text-[8px] text-text-void">
                  {formatDuration(stageData.startedAt, stageData.completedAt)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}
