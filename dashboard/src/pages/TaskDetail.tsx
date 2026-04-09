import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, RotateCcw, XCircle } from "lucide-react";
import {
  fetchTask,
  fetchTaskLogs,
  fetchArtifact,
  retryTask,
  cancelTask,
  type TaskDetail as TaskDetailType,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card } from "@dashboard/components/Card";
import { LogViewer } from "@dashboard/components/LogViewer";
import { shortId, formatDate } from "@dashboard/lib/utils";
import { useState } from "react";

const ARTIFACTS = [
  { key: "plan.md", label: "Plan" },
  { key: "implementation-summary.md", label: "Implementation Summary" },
  { key: "review.md", label: "Review" },
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
  const [activeArtifact, setActiveArtifact] = useState<string | null>(null);
  const [artifactContent, setArtifactContent] = useState<string>("");
  const [artifactLoading, setArtifactLoading] = useState(false);

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
    (e) => (e as { taskId?: string }).taskId === id
  );

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
      <div className="p-6 text-sm text-text-muted">Loading task...</div>
    );
  }

  if (!task) {
    return <div className="p-6 text-sm text-text-muted">Task not found</div>;
  }

  const isActive = ![
    "complete",
    "failed",
    "cancelled",
  ].includes(task.status);

  const sortedStages = [...(task.stages ?? [])].sort(
    (a, b) => STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage)
  );

  return (
    <div className="p-6 max-w-4xl">
      {/* Header */}
      <button
        onClick={() => navigate(-1)}
        className="mb-4 flex items-center gap-1.5 text-xs text-text-muted hover:text-text transition-colors"
      >
        <ArrowLeft size={14} />
        Back
      </button>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <code className="text-sm text-text-muted">{shortId(task.id)}</code>
            <span className="text-sm font-medium text-brand">{task.repo}</span>
            <StatusBadge status={task.status} />
          </div>
          <p className="text-sm text-text-dim">{task.description}</p>
          <div className="mt-1 flex gap-3 text-xs text-text-muted">
            <span>Created {formatDate(task.createdAt)}</span>
            {task.completedAt && (
              <span>Completed {formatDate(task.completedAt)}</span>
            )}
            {task.branch && <span>Branch: {task.branch}</span>}
          </div>
        </div>

        <div className="flex gap-2 shrink-0">
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-md bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-dim hover:text-text transition-colors"
            >
              <ExternalLink size={12} />
              PR #{task.prNumber}
            </a>
          )}
          {task.status === "failed" && (
            <button
              onClick={handleRetry}
              className="flex items-center gap-1.5 rounded-md bg-surface-raised px-3 py-1.5 text-xs font-medium text-text-dim hover:text-text transition-colors"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          )}
          {isActive && (
            <button
              onClick={handleCancel}
              className="flex items-center gap-1.5 rounded-md bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 hover:text-red-300 transition-colors"
            >
              <XCircle size={12} />
              Cancel
            </button>
          )}
        </div>
      </div>

      {/* Error */}
      {task.error && (
        <Card className="mb-4 border-red-500/30 bg-red-500/5">
          <p className="text-sm font-medium text-red-400">Error</p>
          <p className="mt-1 text-xs text-red-400/80 whitespace-pre-wrap">
            {task.error}
          </p>
        </Card>
      )}

      {/* Stage timeline */}
      <h2 className="mb-3 text-sm font-medium">Stages</h2>
      <div className="mb-6 space-y-2">
        {sortedStages.length === 0 ? (
          <p className="text-xs text-text-muted">No stages recorded yet</p>
        ) : (
          sortedStages.map((stage) => (
            <Card key={stage.id} className="py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium capitalize">
                    {stage.stage.replace("_", " ")}
                  </span>
                  <StatusBadge status={stage.status} />
                </div>
                <div className="flex gap-3 text-xs text-text-muted">
                  <span>Started {formatDate(stage.startedAt)}</span>
                  {stage.completedAt && (
                    <span>Done {formatDate(stage.completedAt)}</span>
                  )}
                </div>
              </div>
              {stage.error && (
                <p className="mt-1 text-xs text-red-400">{stage.error}</p>
              )}
            </Card>
          ))
        )}
      </div>

      {/* Artifacts */}
      <h2 className="mb-3 text-sm font-medium">Artifacts</h2>
      <div className="mb-6">
        <div className="flex gap-2 mb-3">
          {ARTIFACTS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => loadArtifact(key)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                activeArtifact === key
                  ? "bg-brand/20 text-brand"
                  : "bg-surface-raised text-text-dim hover:text-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {activeArtifact && (
          <Card>
            {artifactLoading ? (
              <p className="text-xs text-text-muted">Loading...</p>
            ) : (
              <pre className="text-xs text-text-dim whitespace-pre-wrap overflow-auto max-h-96">
                {artifactContent}
              </pre>
            )}
          </Card>
        )}
      </div>

      {/* Logs */}
      <h2 className="mb-3 text-sm font-medium">Logs</h2>
      {logsData?.logs && logsData.logs.length > 0 ? (
        <div className="space-y-3">
          {logsData.logs.map(({ stage, lines }) => (
            <div key={stage}>
              <p className="mb-1 text-xs font-medium text-text-dim capitalize">
                {stage.replace("_", " ")}
              </p>
              <LogViewer lines={lines} maxHeight="300px" />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-text-muted">No logs available</p>
      )}
    </div>
  );
}
