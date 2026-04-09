import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  RotateCcw,
  XCircle,
  Clock,
  GitBranch,
  FileText,
} from "lucide-react";
import {
  fetchTask,
  fetchTaskLogs,
  fetchArtifact,
  retryTask,
  cancelTask,
  type TaskDetail as TaskDetailType,
  type LogEntry,
  type StageLogs,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card } from "@dashboard/components/Card";
import { LogViewer } from "@dashboard/components/LogViewer";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { shortId, formatDate, timeAgo } from "@dashboard/lib/utils";
import { useState, useCallback, useEffect } from "react";

const ARTIFACTS = [
  { key: "plan.md", label: "Plan", icon: FileText },
  { key: "implementation-summary.md", label: "Summary", icon: FileText },
  { key: "review.md", label: "Review", icon: FileText },
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
  const [activeTab, setActiveTab] = useState<"logs" | "artifacts">("logs");
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

  // SSE: refetch task data + collect live logs
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
        if (
          event.type === "log" &&
          (event.taskId as string) === id
        ) {
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

  // Auto-select the active/latest stage
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
      <div className="p-6 text-sm text-zinc-500">Loading task...</div>
    );
  }

  if (!task) {
    return <div className="p-6 text-sm text-zinc-500">Task not found</div>;
  }

  const isActive = !["complete", "failed", "cancelled"].includes(task.status);

  // Merge disk logs with live SSE logs for the selected stage
  const diskLogs = logsData?.logs ?? [];
  function getLogsForStage(stage: string): LogEntry[] {
    const disk = diskLogs.find((l) => l.stage === stage)?.entries ?? [];
    const live = liveLogs.get(stage) ?? [];
    // Deduplicate by seq -- prefer disk entries, append live entries with higher seq
    const maxDiskSeq = disk.length > 0 ? disk[disk.length - 1].seq : -1;
    const newLive = live.filter((e) => e.seq > maxDiskSeq);
    return [...disk, ...newLive];
  }

  const allStages = [...new Set([
    ...STAGE_ORDER.filter((s) =>
      task.stages.some((ts) => ts.stage === s)
    ),
    ...Array.from(liveLogs.keys()),
  ])];

  return (
    <div className="p-6 max-w-5xl">
      {/* Back button */}
      <button
        onClick={() => navigate(-1)}
        className="mb-4 flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <div className="flex items-center gap-2 mb-1.5">
              <code className="text-sm text-zinc-600 font-mono">
                {shortId(task.id)}
              </code>
              <span className="text-sm font-medium text-violet-400">
                {task.repo}
              </span>
              <StatusBadge status={task.status} />
            </div>
            <p className="text-[15px] text-zinc-300 leading-relaxed">
              {task.description}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-600">
              <span className="flex items-center gap-1">
                <Clock size={11} />
                Created {formatDate(task.createdAt)}
              </span>
              {task.completedAt && (
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  Completed {timeAgo(task.completedAt)}
                </span>
              )}
              {task.branch && (
                <span className="flex items-center gap-1">
                  <GitBranch size={11} />
                  {task.branch}
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 shrink-0">
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <ExternalLink size={12} />
                PR #{task.prNumber}
              </a>
            )}
            {task.status === "failed" && (
              <button
                onClick={handleRetry}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                <RotateCcw size={12} />
                Retry
              </button>
            )}
            {isActive && (
              <button
                onClick={handleCancel}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
              >
                <XCircle size={12} />
                Cancel
              </button>
            )}
          </div>
        </div>

        {/* Error banner */}
        {task.error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3 mb-4">
            <p className="text-xs font-medium text-red-400 mb-0.5">
              Error
            </p>
            <p className="text-xs text-red-400/70 whitespace-pre-wrap">
              {task.error}
            </p>
          </div>
        )}

        {/* Pipeline visualization */}
        <div className="flex justify-center py-5 rounded-lg border border-zinc-800/50 bg-zinc-900/30">
          <PipelineProgress
            stages={task.stages}
            taskStatus={task.status}
          />
        </div>
      </div>

      {/* Tabs: Logs | Artifacts */}
      <div className="flex gap-1 rounded-lg bg-zinc-900 p-1 w-fit mb-4">
        <button
          onClick={() => setActiveTab("logs")}
          className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
            activeTab === "logs"
              ? "bg-zinc-800 text-zinc-200 shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Logs
        </button>
        <button
          onClick={() => setActiveTab("artifacts")}
          className={`rounded-md px-4 py-1.5 text-xs font-medium transition-colors ${
            activeTab === "artifacts"
              ? "bg-zinc-800 text-zinc-200 shadow-sm"
              : "text-zinc-500 hover:text-zinc-300"
          }`}
        >
          Artifacts
        </button>
      </div>

      {/* Logs tab */}
      {activeTab === "logs" && (
        <div>
          {/* Stage selector */}
          {allStages.length > 0 && (
            <div className="flex gap-1 mb-3">
              {allStages.map((stage) => {
                const stageData = task.stages.find(
                  (s) => s.stage === stage
                );
                return (
                  <button
                    key={stage}
                    onClick={() => setActiveStage(stage)}
                    className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      activeStage === stage
                        ? "bg-violet-500/15 text-violet-300"
                        : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                    }`}
                  >
                    <span className="capitalize">
                      {stage.replace("_", " ")}
                    </span>
                    {stageData && (
                      <StatusBadge
                        status={stageData.status}
                        className="text-[9px] px-1.5 py-0"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Log viewer for selected stage */}
          {activeStage ? (
            <LogViewer
              entries={getLogsForStage(activeStage)}
              maxHeight="500px"
              autoScroll={isActive}
            />
          ) : (
            <p className="text-xs text-zinc-600">
              No stages recorded yet
            </p>
          )}
        </div>
      )}

      {/* Artifacts tab */}
      {activeTab === "artifacts" && (
        <div>
          <div className="flex gap-2 mb-3">
            {ARTIFACTS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => loadArtifact(key)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeArtifact === key
                    ? "bg-violet-500/15 text-violet-300"
                    : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>
          {activeArtifact && (
            <Card>
              {artifactLoading ? (
                <p className="text-xs text-zinc-500">Loading...</p>
              ) : (
                <pre className="text-xs text-zinc-400 whitespace-pre-wrap overflow-auto max-h-[600px] leading-relaxed">
                  {artifactContent}
                </pre>
              )}
            </Card>
          )}
          {!activeArtifact && (
            <p className="text-xs text-zinc-600">
              Select an artifact to view
            </p>
          )}
        </div>
      )}
    </div>
  );
}
