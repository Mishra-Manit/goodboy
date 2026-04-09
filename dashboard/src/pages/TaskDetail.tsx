import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, RotateCcw, XCircle } from "lucide-react";
import {
  fetchTask,
  fetchTaskLogs,
  fetchArtifact,
  retryTask,
  cancelTask,
  type TaskDetail as TaskDetailType,
  type LogEntry,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { LogViewer } from "@dashboard/components/LogViewer";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { shortId, formatDate, timeAgo } from "@dashboard/lib/utils";
import { cn } from "@dashboard/lib/utils";
import { useState, useCallback, useEffect } from "react";

const ARTIFACTS = [
  { key: "plan.md", label: "plan" },
  { key: "implementation-summary.md", label: "summary" },
  { key: "review.md", label: "review" },
];

const STAGE_ORDER = [
  "planner",
  "implementer",
  "reviewer",
  "pr_creator",
  "revision",
];

export function TaskDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [activeArtifact, setActiveArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string>("");
  const [artifactLoading, setArtifactLoading] = useState(false);
  const [liveLogs, setLiveLogs] = useState<Map<string, LogEntry[]>>(
    new Map()
  );

  const {
    data: task,
    loading,
    refetch,
  } = useQuery(() => fetchTask(id!), [id]);
  const { data: logsData, refetch: refetchLogs } = useQuery(
    () => fetchTaskLogs(id!),
    [id]
  );

  useSSERefresh(
    () => {
      refetch();
      refetchLogs();
    },
    (e) =>
      (e.type === "task_update" || e.type === "stage_update") &&
      (e as { taskId?: string }).taskId === id
  );

  useSSE(
    useCallback(
      (event) => {
        if (event.type === "log" && (event.taskId as string) === id) {
          const stage = event.stage as string;
          const entry = event.entry as LogEntry;
          if (entry) {
            setLiveLogs((prev) => {
              const next = new Map(prev);
              const existing = next.get(stage) ?? [];
              next.set(stage, [...existing, entry]);
              return next;
            });
          }
        }
      },
      [id]
    )
  );

  useEffect(() => {
    if (task && !activeStage) {
      const sorted = [...(task.stages ?? [])].sort(
        (a, b) =>
          STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
      );
      const running = sorted.find((s) => s.status === "running");
      const latest = sorted[sorted.length - 1];
      setActiveStage(running?.stage ?? latest?.stage ?? null);
    }
  }, [task, activeStage]);

  async function loadArtifact(name: string) {
    if (activeArtifact === name) {
      setActiveArtifact(null);
      return;
    }
    setArtifactLoading(true);
    try {
      const content = await fetchArtifact(id!, name);
      setArtifactContent(content);
      setActiveArtifact(name);
    } catch {
      setArtifactContent("Failed to load artifact");
      setActiveArtifact(name);
    } finally {
      setArtifactLoading(false);
    }
  }

  async function handleRetry() {
    if (!task) return;
    await retryTask(task.id);
    refetch();
  }

  async function handleCancel() {
    if (!task) return;
    await cancelTask(task.id);
    refetch();
  }

  if (loading && !task) {
    return (
      <div className="py-24 text-center">
        <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
          loading task...
        </span>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="py-24 text-center">
        <span className="font-mono text-xs text-text-ghost">task not found</span>
      </div>
    );
  }

  const isActive = !["complete", "failed", "cancelled"].includes(task.status);
  const diskLogs = logsData?.logs ?? [];

  function getLogsForStage(stage: string): LogEntry[] {
    const disk = diskLogs.find((l) => l.stage === stage)?.entries ?? [];
    const live = liveLogs.get(stage) ?? [];
    const maxDiskSeq = disk.length > 0 ? disk[disk.length - 1].seq : -1;
    const newLive = live.filter((e) => e.seq > maxDiskSeq);
    return [...disk, ...newLive];
  }

  const allStages = [
    ...new Set([
      ...STAGE_ORDER.filter((s) =>
        task.stages.some((ts) => ts.stage === s)
      ),
      ...Array.from(liveLogs.keys()),
    ]),
  ];

  return (
    <div className="animate-fade-in">
      {/* Back */}
      <button
        onClick={() => navigate(-1)}
        className="mb-6 flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
      >
        <ArrowLeft size={12} />
        back
      </button>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <code className="font-mono text-[11px] text-text-ghost">
            {shortId(task.id)}
          </code>
          <span className="font-mono text-[11px] font-medium text-accent">
            {task.repo}
          </span>
          <StatusBadge status={task.status} />
        </div>

        <p className="text-[15px] text-text leading-relaxed">
          {task.description}
        </p>

        {/* Meta row */}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-text-void">
          <span>created {formatDate(task.createdAt)}</span>
          {task.completedAt && <span>completed {timeAgo(task.completedAt)}</span>}
          {task.branch && <span>branch: {task.branch}</span>}
        </div>

        {/* Actions */}
        <div className="mt-3 flex gap-2">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
            >
              <ExternalLink size={10} />
              PR #{task.prNumber}
            </a>
          )}
          {task.status === "failed" && (
            <button
              onClick={handleRetry}
              className="flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
            >
              <RotateCcw size={10} />
              retry
            </button>
          )}
          {isActive && (
            <button
              onClick={handleCancel}
              className="flex items-center gap-1.5 font-mono text-[10px] text-fail/60 hover:text-fail transition-colors"
            >
              <XCircle size={10} />
              cancel
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {task.error && (
        <div className="mb-6 rounded-md bg-fail-dim px-4 py-3">
          <span className="font-mono text-[10px] text-fail/80 block mb-0.5">error</span>
          <p className="font-mono text-[11px] text-fail/70 whitespace-pre-wrap">
            {task.error}
          </p>
        </div>
      )}

      {/* Pipeline */}
      <div className="mb-8 flex justify-center py-4">
        <PipelineProgress stages={task.stages} taskStatus={task.status} />
      </div>

      {/* Logs */}
      <SectionDivider label="logs" />

      {/* Stage tabs */}
      {allStages.length > 0 && (
        <div className="mt-3 mb-3 flex gap-1">
          {allStages.map((stage) => {
            const stageData = task.stages.find((s) => s.stage === stage);
            return (
              <button
                key={stage}
                onClick={() => setActiveStage(stage)}
                className={cn(
                  "flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[10px] transition-all duration-200",
                  activeStage === stage
                    ? "bg-glass text-text"
                    : "text-text-ghost hover:text-text-dim"
                )}
              >
                {stage.replace("_", " ")}
                {stageData && (
                  <StatusBadge status={stageData.status} className="text-[8px]" />
                )}
              </button>
            );
          })}
        </div>
      )}

      {activeStage ? (
        <LogViewer
          entries={getLogsForStage(activeStage)}
          maxHeight="500px"
          autoScroll={isActive}
        />
      ) : (
        <p className="font-mono text-xs text-text-void py-4">
          no stages recorded yet
        </p>
      )}

      {/* Artifacts */}
      <SectionDivider label="artifacts" className="mt-8" />

      <div className="mt-3 flex gap-1.5">
        {ARTIFACTS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => loadArtifact(key)}
            className={cn(
              "rounded-full px-3 py-1 font-mono text-[10px] transition-all duration-200",
              activeArtifact === key
                ? "bg-glass text-text"
                : "text-text-ghost hover:text-text-dim"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {activeArtifact && (
        <div className="mt-3 rounded-lg bg-bg-raised p-4 animate-fade-up">
          {artifactLoading ? (
            <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
              loading...
            </span>
          ) : (
            <pre className="font-mono text-[11px] text-text-dim whitespace-pre-wrap overflow-auto max-h-[600px] leading-relaxed">
              {artifactContent}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
