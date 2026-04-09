import { cn } from "@dashboard/lib/utils";
import type { TaskStage } from "@dashboard/lib/api";
import {
  Brain,
  Code2,
  SearchCheck,
  GitPullRequestCreate,
  RefreshCw,
  Check,
  Loader2,
  Circle,
  XCircle,
} from "lucide-react";

const PIPELINE_STAGES = [
  { key: "planner", label: "Plan", icon: Brain },
  { key: "implementer", label: "Implement", icon: Code2 },
  { key: "reviewer", label: "Review", icon: SearchCheck },
  { key: "pr_creator", label: "PR", icon: GitPullRequestCreate },
] as const;

interface PipelineProgressProps {
  stages: TaskStage[];
  taskStatus: string;
  className?: string;
  /** Mini mode for card previews */
  mini?: boolean;
}

export function PipelineProgress({
  stages,
  taskStatus,
  className,
  mini = false,
}: PipelineProgressProps) {
  const stageMap = new Map(stages.map((s) => [s.stage, s]));
  const hasRevision = stageMap.has("revision");

  return (
    <div className={cn("flex items-center", mini ? "gap-1" : "gap-0", className)}>
      {PIPELINE_STAGES.map((ps, i) => {
        const stage = stageMap.get(ps.key);
        const status = getStageDisplayStatus(ps.key, stage, taskStatus);

        return mini ? (
          <MiniStageNode key={ps.key} status={status} label={ps.label} />
        ) : (
          <div key={ps.key} className="flex items-center">
            {i > 0 && <Connector status={status} />}
            <StageNode
              icon={ps.icon}
              label={ps.label}
              status={status}
              stage={stage}
            />
          </div>
        );
      })}

      {hasRevision && !mini && (
        <div className="flex items-center">
          <Connector status="complete" />
          <StageNode
            icon={RefreshCw}
            label="Revision"
            status={getStageDisplayStatus(
              "revision",
              stageMap.get("revision"),
              taskStatus
            )}
            stage={stageMap.get("revision")}
          />
        </div>
      )}
    </div>
  );
}

type DisplayStatus = "pending" | "active" | "complete" | "failed";

function getStageDisplayStatus(
  stageKey: string,
  stage: TaskStage | undefined,
  taskStatus: string
): DisplayStatus {
  if (!stage) {
    if (taskStatus === "failed" || taskStatus === "cancelled") return "pending";
    return "pending";
  }
  if (stage.status === "complete") return "complete";
  if (stage.status === "failed") return "failed";
  if (stage.status === "running") return "active";
  return "pending";
}

const STATUS_STYLES: Record<DisplayStatus, { ring: string; bg: string; text: string }> = {
  pending: {
    ring: "border-zinc-700",
    bg: "bg-zinc-900",
    text: "text-zinc-600",
  },
  active: {
    ring: "border-violet-500 shadow-[0_0_12px_rgba(139,92,246,0.3)]",
    bg: "bg-violet-500/10",
    text: "text-violet-400",
  },
  complete: {
    ring: "border-emerald-500/50",
    bg: "bg-emerald-500/10",
    text: "text-emerald-400",
  },
  failed: {
    ring: "border-red-500/50",
    bg: "bg-red-500/10",
    text: "text-red-400",
  },
};

function StageNode({
  icon: Icon,
  label,
  status,
  stage,
}: {
  icon: typeof Brain;
  label: string;
  status: DisplayStatus;
  stage?: TaskStage;
}) {
  const styles = STATUS_STYLES[status];
  const StatusIcon =
    status === "complete"
      ? Check
      : status === "failed"
        ? XCircle
        : status === "active"
          ? Loader2
          : Circle;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={cn(
          "relative flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all",
          styles.ring,
          styles.bg
        )}
      >
        <Icon size={18} className={styles.text} />
        {status === "active" && (
          <div className="absolute inset-0 animate-ping rounded-full border border-violet-500/20" />
        )}
        {/* Status indicator dot */}
        <div className="absolute -bottom-0.5 -right-0.5">
          <StatusIcon
            size={12}
            className={cn(
              status === "active" && "animate-spin",
              styles.text
            )}
          />
        </div>
      </div>
      <span
        className={cn(
          "text-[10px] font-medium",
          status === "active" ? "text-violet-300" : "text-zinc-500"
        )}
      >
        {label}
      </span>
      {stage?.completedAt && stage.startedAt && (
        <span className="text-[9px] text-zinc-600">
          {formatDuration(stage.startedAt, stage.completedAt)}
        </span>
      )}
    </div>
  );
}

function MiniStageNode({
  status,
  label,
}: {
  status: DisplayStatus;
  label: string;
}) {
  const styles = STATUS_STYLES[status];
  return (
    <div
      title={label}
      className={cn(
        "h-2 w-2 rounded-full border transition-all",
        styles.ring,
        status === "complete" && "bg-emerald-500",
        status === "active" && "bg-violet-500 animate-pulse",
        status === "failed" && "bg-red-500",
        status === "pending" && "bg-zinc-800"
      )}
    />
  );
}

function Connector({ status }: { status: DisplayStatus }) {
  return (
    <div
      className={cn(
        "h-px w-8 mx-1",
        status === "complete" || status === "active"
          ? "bg-zinc-600"
          : "bg-zinc-800"
      )}
    />
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
