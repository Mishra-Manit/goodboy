/** Task detail: header, pipeline viz, per-stage logs, artifact viewer. */

import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  cancelTask,
  fetchTask,
  fetchTaskLogs,
  retryTask,
  TASK_KIND_CONFIG,
  type LogEntry,
  type TaskWithStages,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useLiveLogs } from "@dashboard/hooks/use-live-logs";
import { useNow } from "@dashboard/hooks/use-now";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { TaskHeader } from "@dashboard/components/TaskHeader";
import { ArtifactsPanel } from "@dashboard/components/ArtifactsPanel";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { LogViewer } from "@dashboard/components/log-viewer";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { mergeLogEntries } from "@dashboard/lib/logs";
import { cn } from "@dashboard/lib/utils";

const TERMINAL = new Set(["complete", "failed", "cancelled"]);

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/" replace />;
  const taskId = id;

  const navigate = useNavigate();
  const now = useNow();

  const { data: task, loading, error, refetch } = useQuery(() => fetchTask(taskId), [taskId]);
  const { data: logsData, refetch: refetchLogs } = useQuery(() => fetchTaskLogs(taskId), [taskId]);

  useSSERefresh(
    () => {
      refetch();
      refetchLogs();
    },
    (e) => (e.type === "task_update" || e.type === "stage_update") && e.taskId === taskId,
  );

  const liveLogs = useLiveLogs({
    match: (event) =>
      event.type === "log" && event.taskId === taskId
        ? { key: event.stage, entry: event.entry }
        : null,
  });

  return (
    <div className="animate-fade-in">
      <BackLink label="back" onClick={() => navigate(-1)} />
      <PageState data={task} loading={loading} error={error} onRetry={refetch} loadingLabel="loading task...">
        {(task) => (
          <TaskView
            task={task}
            diskLogs={logsData?.logs ?? []}
            liveLogs={liveLogs}
            now={now}
            refetch={refetch}
            taskId={taskId}
          />
        )}
      </PageState>
    </div>
  );
}

// --- Main view ---

interface TaskViewProps {
  task: TaskWithStages;
  diskLogs: { stage: string; entries: LogEntry[] }[];
  liveLogs: Map<string, LogEntry[]>;
  now: number;
  refetch: () => void;
  taskId: string;
}

function TaskView({ task, diskLogs, liveLogs, now, refetch, taskId }: TaskViewProps) {
  const kindConfig = TASK_KIND_CONFIG[task.kind] ?? TASK_KIND_CONFIG.coding_task;
  const isActive = !TERMINAL.has(task.status);

  const stageNames = useMemo(
    () => [
      ...new Set([
        ...kindConfig.stages.filter((s) => task.stages.some((ts) => ts.stage === s)),
        ...liveLogs.keys(),
      ]),
    ],
    [kindConfig.stages, task.stages, liveLogs],
  );

  const [activeStage, setActiveStage] = useState<string | null>(null);
  useEffect(() => {
    if (activeStage && stageNames.includes(activeStage)) return;
    const running = task.stages.find((s) => s.status === "running")?.stage;
    setActiveStage(running ?? stageNames[stageNames.length - 1] ?? null);
  }, [task.stages, stageNames, activeStage]);

  const logsForStage = (stage: string): LogEntry[] =>
    mergeLogEntries(
      diskLogs.find((l) => l.stage === stage)?.entries ?? [],
      liveLogs.get(stage) ?? [],
    );

  const handleRetry = async () => {
    try { await retryTask(task.id); refetch(); } catch { /* status will surface */ }
  };
  const handleCancel = async () => {
    try { await cancelTask(task.id); refetch(); } catch { /* status will surface */ }
  };

  return (
    <>
      <TaskHeader task={task} now={now} isActive={isActive} onRetry={handleRetry} onCancel={handleCancel} />

      {task.error && (
        <div className="mb-6 rounded-md bg-fail-dim px-4 py-3">
          <span className="font-mono text-[10px] text-fail/80 block mb-0.5">error</span>
          <p className="font-mono text-[11px] text-fail/70 whitespace-pre-wrap">{task.error}</p>
        </div>
      )}

      {kindConfig.stages.length > 1 && (
        <div className="mb-8 flex justify-center py-4">
          <PipelineProgress stages={task.stages} kind={task.kind} />
        </div>
      )}

      {task.kind === "pr_review" && task.prIdentifier && (
        <div className="mb-6 font-mono text-[11px] text-text-ghost">reviewing: {task.prIdentifier}</div>
      )}

      <SectionDivider label="logs" />

      {stageNames.length > 0 && (
        <div className="mt-3 mb-3 flex gap-1">
          {stageNames.map((stage) => {
            const data = task.stages.find((s) => s.stage === stage);
            return (
              <button
                key={stage}
                onClick={() => setActiveStage(stage)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px]",
                  "transition-all duration-200",
                  activeStage === stage ? "bg-glass text-text" : "text-text-ghost hover:text-text-dim",
                )}
              >
                {stage.replace("_", " ")}
                {data && <StatusBadge status={data.status} className="text-[8px]" />}
              </button>
            );
          })}
        </div>
      )}

      {activeStage ? (
        <LogViewer entries={logsForStage(activeStage)} maxHeight="500px" autoScroll={isActive} />
      ) : (
        <p className="font-mono text-xs text-text-void py-4">no stages recorded yet</p>
      )}

      <SectionDivider label="artifacts" className="mt-8" />
      <ArtifactsPanel taskId={taskId} artifacts={kindConfig.artifacts} />
    </>
  );
}
