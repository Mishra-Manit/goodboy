import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { ListTodo, Zap } from "lucide-react";
import {
  fetchTasks,
  fetchTask,
  type Task,
  type TaskDetail,
  type LogEntry,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { Card, CardHeader } from "@dashboard/components/Card";
import { LogViewer } from "@dashboard/components/LogViewer";
import { EmptyState } from "@dashboard/components/EmptyState";
import { shortId, timeAgo } from "@dashboard/lib/utils";

const ACTIVE_STATUSES = new Set([
  "queued",
  "planning",
  "implementing",
  "reviewing",
  "creating_pr",
  "revision",
]);

export function ActiveTasks() {
  const navigate = useNavigate();
  const { data: tasks, loading, refetch } = useQuery(() => fetchTasks());
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<Map<string, TaskDetail>>(
    new Map()
  );
  const [liveLogs, setLiveLogs] = useState<Map<string, LogEntry[]>>(
    new Map()
  );

  useSSERefresh(refetch, (e) => e.type === "task_update");

  // Collect live log entries from SSE
  useSSE(
    useCallback((event) => {
      if (event.type === "log") {
        const taskId = event.taskId as string;
        const entry = event.entry as LogEntry;
        if (entry) {
          setLiveLogs((prev) => {
            const next = new Map(prev);
            const existing = next.get(taskId) ?? [];
            next.set(taskId, [...existing, entry]);
            return next;
          });
        }
      }
      if (event.type === "stage_update" || event.type === "task_update") {
        const taskId = event.taskId as string;
        // Refetch task detail to get updated stages
        if (taskId === expandedTask) {
          fetchTask(taskId).then((detail) => {
            setTaskDetails((prev) => {
              const next = new Map(prev);
              next.set(taskId, detail);
              return next;
            });
          });
        }
      }
    }, [expandedTask])
  );

  const activeTasks = (tasks ?? []).filter((t) =>
    ACTIVE_STATUSES.has(t.status)
  );

  async function toggleExpand(taskId: string) {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      return;
    }
    setExpandedTask(taskId);
    if (!taskDetails.has(taskId)) {
      const detail = await fetchTask(taskId);
      setTaskDetails((prev) => {
        const next = new Map(prev);
        next.set(taskId, detail);
        return next;
      });
    }
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Zap size={18} className="text-violet-400" />
          <h1 className="text-lg font-semibold text-zinc-100">Active Tasks</h1>
        </div>
        <p className="text-sm text-zinc-500">
          Currently running tasks with live pipeline visibility
        </p>
      </div>

      {loading && !tasks ? (
        <div className="text-sm text-zinc-500">Loading...</div>
      ) : activeTasks.length === 0 ? (
        <EmptyState
          icon={<ListTodo size={32} />}
          title="No active tasks"
          description="Send a task via Telegram to get started"
        />
      ) : (
        <div className="space-y-3">
          {activeTasks.map((task) => {
            const detail = taskDetails.get(task.id);
            const logs = liveLogs.get(task.id) ?? [];
            const isExpanded = expandedTask === task.id;

            return (
              <div key={task.id}>
                <Card
                  hoverable
                  onClick={() => toggleExpand(task.id)}
                  className={isExpanded ? "border-violet-500/30" : ""}
                >
                  <CardHeader>
                    <div className="flex items-center gap-3">
                      <code className="text-xs text-zinc-600 font-mono">
                        {shortId(task.id)}
                      </code>
                      <span className="text-xs font-medium text-violet-400">
                        {task.repo}
                      </span>
                      <StatusBadge status={task.status} />
                    </div>
                    <div className="flex items-center gap-3">
                      {detail && (
                        <PipelineProgress
                          stages={detail.stages}
                          taskStatus={task.status}
                          mini
                        />
                      )}
                      <span className="text-[11px] text-zinc-600">
                        {timeAgo(task.createdAt)}
                      </span>
                    </div>
                  </CardHeader>
                  <p className="text-sm text-zinc-400 line-clamp-2">
                    {task.description}
                  </p>
                </Card>

                {/* Expanded: pipeline + live logs */}
                {isExpanded && (
                  <div className="mt-1 ml-4 space-y-3 animate-in fade-in slide-in-from-top-1 duration-200">
                    {/* Pipeline visualization */}
                    {detail && (
                      <div className="flex justify-center py-4">
                        <PipelineProgress
                          stages={detail.stages}
                          taskStatus={task.status}
                        />
                      </div>
                    )}

                    {/* Live logs */}
                    <LogViewer
                      entries={logs}
                      maxHeight="350px"
                      autoScroll
                    />

                    {/* Link to full detail */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/tasks/${task.id}`);
                      }}
                      className="text-xs text-violet-400 hover:text-violet-300 transition-colors"
                    >
                      View full detail
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
