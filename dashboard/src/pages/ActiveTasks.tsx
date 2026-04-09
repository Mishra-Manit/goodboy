import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
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
import { Card } from "@dashboard/components/Card";
import { LogViewer } from "@dashboard/components/LogViewer";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
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

  useSSE(
    useCallback(
      (event) => {
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
      },
      [expandedTask]
    )
  );

  const activeTasks = (tasks ?? []).filter((t) =>
    ACTIVE_STATUSES.has(t.status)
  );

  const recentCompleted = (tasks ?? [])
    .filter((t) => !ACTIVE_STATUSES.has(t.status))
    .slice(0, 6);

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
    <div>
      {/* Page header */}
      <header className="mb-10 text-center">
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">
          goodboy
        </h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost tracking-wide">
          background coding agent
        </p>
      </header>

      {/* Live section */}
      <SectionDivider
        label="live"
        detail={activeTasks.length > 0 ? `${activeTasks.length} task${activeTasks.length === 1 ? "" : "s"}` : undefined}
      />

      {loading && !tasks ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            connecting...
          </span>
        </div>
      ) : activeTasks.length === 0 ? (
        <EmptyState
          title="No active tasks"
          description="Send a task via Telegram to get started"
        />
      ) : (
        <div className="mt-4 space-y-3 stagger">
          {activeTasks.map((task) => {
            const detail = taskDetails.get(task.id);
            const logs = liveLogs.get(task.id) ?? [];
            const isExpanded = expandedTask === task.id;

            return (
              <div key={task.id} className="animate-fade-up">
                <Card
                  hoverable
                  live
                  onClick={() => toggleExpand(task.id)}
                >
                  {/* Top row: ID, repo, status */}
                  <div className="flex items-center gap-3 mb-2">
                    <code className="font-mono text-[10px] text-text-ghost">
                      {shortId(task.id)}
                    </code>
                    <span className="font-mono text-[11px] font-medium text-accent">
                      {task.repo}
                    </span>
                    <StatusBadge status={task.status} />
                    <span className="ml-auto font-mono text-[10px] text-text-void">
                      {timeAgo(task.createdAt)}
                    </span>
                  </div>

                  {/* Description */}
                  <p className="text-[13px] text-text-secondary leading-relaxed line-clamp-2">
                    {task.description}
                  </p>

                  {/* Inline pipeline */}
                  {detail && (
                    <div className="mt-3 flex items-center justify-between">
                      <PipelineProgress
                        stages={detail.stages}
                        taskStatus={task.status}
                      />
                      {detail && (
                        <PipelineProgress
                          stages={detail.stages}
                          taskStatus={task.status}
                          mini
                          className="sm:hidden"
                        />
                      )}
                    </div>
                  )}
                </Card>

                {/* Expanded: live logs */}
                {isExpanded && (
                  <div className="mt-2 animate-fade-up">
                    <LogViewer entries={logs} maxHeight="350px" autoScroll />

                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/tasks/${task.id}`);
                      }}
                      className="mt-2 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
                    >
                      view full detail &rarr;
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent section */}
      {recentCompleted.length > 0 && (
        <>
          <SectionDivider label="recent" className="mt-10" />
          <div className="mt-3 space-y-1 stagger">
            {recentCompleted.map((task) => (
              <RecentRow
                key={task.id}
                task={task}
                onClick={() => navigate(`/tasks/${task.id}`)}
              />
            ))}
          </div>
          <button
            onClick={() => navigate("/history")}
            className="mt-3 block font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
          >
            view all history &rarr;
          </button>
        </>
      )}
    </div>
  );
}

function RecentRow({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-glass animate-fade-up"
    >
      <code className="shrink-0 font-mono text-[10px] text-text-void">
        {shortId(task.id)}
      </code>
      <span className="shrink-0 font-mono text-[10px] text-accent/60">
        {task.repo}
      </span>
      <span className="flex-1 truncate text-xs text-text-dim group-hover:text-text-secondary transition-colors">
        {task.description}
      </span>
      <StatusBadge status={task.status} />
      <span className="shrink-0 font-mono text-[10px] text-text-void">
        {timeAgo(task.createdAt)}
      </span>
      {task.error && (
        <span className="shrink-0 font-mono text-[9px] text-fail/50 max-w-[120px] truncate">
          {task.error}
        </span>
      )}
    </button>
  );
}
