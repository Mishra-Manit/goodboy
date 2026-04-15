import { cn } from "@dashboard/lib/utils";
import { TASK_KIND_CONFIG, type TaskKind, type TaskStage } from "@dashboard/lib/api";

interface PipelineProgressProps {
  stages: TaskStage[];
  kind: TaskKind;
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
  kind,
  className,
  mini = false,
}: PipelineProgressProps) {
  const stageMap = new Map(stages.map((s) => [s.stage, s]));
  const kindConfig = TASK_KIND_CONFIG[kind] ?? TASK_KIND_CONFIG.coding_task;

  // Build stage list from kind config + revision if present
  const hasRevision = stageMap.has("revision");
  const allStages = [
    ...kindConfig.stages.map((key) => ({
      key,
      label: key.replace(/_/g, " "),
    })),
    ...(hasRevision ? [{ key: "revision", label: "Revision" }] : []),
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
    <div className={cn("flex flex-col gap-1 pl-4", className)}>
      {/* Top row: dots with connector lines between them */}
      <div className="flex items-center">
        {allStages.map((ps, i) => {
          const status = getStatus(stageMap.get(ps.key));
          return (
            <div key={ps.key} className="flex items-center">
              {i > 0 && (
                <div className={cn("h-px w-14", LINE_STYLES[getStatus(stageMap.get(allStages[i - 1].key))])} />
              )}
              <div
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full transition-all",
                  DOT_STYLES[status],
                  status === "active" && "animate-pulse-soft"
                )}
              />
            </div>
          );
        })}
      </div>
      {/* Bottom row: labels aligned under each dot */}
      <div className="flex items-start">
        {allStages.map((ps, i) => {
          const status = getStatus(stageMap.get(ps.key));
          const stageData = stageMap.get(ps.key);
          return (
            <div key={ps.key} className="flex items-start">
              {i > 0 && <div className="w-14 shrink-0" />}
              <div className="flex w-2 flex-col items-center">
                <span
                  className={cn(
                    "whitespace-nowrap font-mono text-[9px] tracking-wide",
                    LABEL_STYLES[status]
                  )}
                >
                  {ps.label}
                </span>
                {stageData?.completedAt && stageData.startedAt && (
                  <span className="whitespace-nowrap font-mono text-[8px] text-text-void">
                    {formatDuration(stageData.startedAt, stageData.completedAt)}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
