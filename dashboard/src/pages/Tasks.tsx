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
import { TaskRow } from "@dashboard/components/TaskRow";
import { shortId, timeAgo, cn } from "@dashboard/lib/utils";

const ACTIVE_STATUSES = new Set([
  "queued",
  "planning",
  "implementing",
  "reviewing",
  "creating_pr",
  "revision",
]);

const HISTORY_FILTERS = ["all", "complete", "failed", "cancelled"] as const;

export function Tasks() {
  const navigate = useNavigate();
  const { data: tasks, loading, refetch } = useQuery(() => fetchTasks());
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [taskDetails, setTaskDetails] = useState<Map<string, TaskDetail>>(
    new Map()
  );
  const [liveLogs, setLiveLogs] = useState<Map<string, LogEntry[]>>(
    new Map()
  );
  const [historyFilter, setHistoryFilter] = useState<string>("all");

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

  const completedTasks = (tasks ?? []).filter(
    (t) => !ACTIVE_STATUSES.has(t.status)
  );

  const filteredHistory = completedTasks.filter((t) => {
    if (historyFilter === "all") return true;
    return t.status === historyFilter;
  });

  const grouped = groupByDate(filteredHistory);

  const historyCounts = {
    all: completedTasks.length,
    complete: completedTasks.filter((t) => t.status === "complete").length,
    failed: completedTasks.filter((t) => t.status === "failed").length,
    cancelled: completedTasks.filter((t) => t.status === "cancelled").length,
  };

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

      {/* ── Live section ── */}
      <SectionDivider
        label="live"
        detail={
          activeTasks.length > 0
            ? `${activeTasks.length} task${activeTasks.length === 1 ? "" : "s"}`
            : undefined
        }
      />

      {loading && !tasks ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            connecting...
          </span>
        </div>
      ) : activeTasks.length === 0 ? (
        <div className="py-8 text-center">
          <span className="font-mono text-[11px] text-text-ghost">
            No active tasks
          </span>
        </div>
      ) : (
        <div className="mt-4 space-y-3 stagger">
          {activeTasks.map((task) => {
            const detail = taskDetails.get(task.id);
            const logs = liveLogs.get(task.id) ?? [];
            const isExpanded = expandedTask === task.id;

            return (
              <div key={task.id} className="animate-fade-up">
                <Card hoverable live onClick={() => toggleExpand(task.id)}>
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
                      <PipelineProgress
                        stages={detail.stages}
                        taskStatus={task.status}
                        mini
                        className="sm:hidden"
                      />
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

      {/* ── History section ── */}
      <SectionDivider label="history" className="mt-10" />

      {/* Filter pills */}
      <div className="mt-3 mb-4 flex gap-1">
        {HISTORY_FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setHistoryFilter(f)}
            className={cn(
              "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
              historyFilter === f
                ? "bg-glass text-text"
                : "text-text-ghost hover:text-text-dim"
            )}
          >
            {f}
            <span className="ml-1.5 text-text-void">
              {historyCounts[f as keyof typeof historyCounts]}
            </span>
          </button>
        ))}
      </div>

      {loading && !tasks ? (
        <div className="py-8 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            loading...
          </span>
        </div>
      ) : filteredHistory.length === 0 ? (
        <EmptyState
          title="No tasks found"
          description={
            historyFilter === "all"
              ? "Tasks will appear here after they finish"
              : `No ${historyFilter} tasks`
          }
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(({ label, tasks: groupTasks }) => (
            <div key={label}>
              <SectionDivider label={label} detail={`${groupTasks.length}`} />
              <div className="mt-2 space-y-0.5 stagger">
                {groupTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    showDuration
                    onClick={() => navigate(`/tasks/${task.id}`)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Helpers ── */

function groupByDate(tasks: Task[]): Array<{ label: string; tasks: Task[] }> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const weekAgo = new Date(today.getTime() - 7 * 86400000);

  const groups: Record<string, Task[]> = {};

  for (const task of tasks) {
    const d = new Date(task.createdAt);
    let label: string;
    if (d >= today) label = "today";
    else if (d >= yesterday) label = "yesterday";
    else if (d >= weekAgo) label = "this week";
    else label = "older";

    if (!groups[label]) groups[label] = [];
    groups[label].push(task);
  }

  const order = ["today", "yesterday", "this week", "older"];
  return order
    .filter((label) => groups[label]?.length)
    .map((label) => ({ label, tasks: groups[label] }));
}
