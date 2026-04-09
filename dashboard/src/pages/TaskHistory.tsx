import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchTasks, type Task } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { EmptyState } from "@dashboard/components/EmptyState";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { shortId, timeAgo } from "@dashboard/lib/utils";
import { cn } from "@dashboard/lib/utils";

const FILTERS = ["all", "complete", "failed", "cancelled"] as const;

export function TaskHistory() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<string>("all");
  const { data: tasks, loading, refetch } = useQuery(() => fetchTasks());

  useSSERefresh(refetch, (e) => e.type === "task_update");

  const filtered = (tasks ?? []).filter((t) => {
    if (filter === "all") return true;
    return t.status === filter;
  });

  // Group by relative date
  const grouped = groupByDate(filtered);

  const counts = {
    all: (tasks ?? []).length,
    complete: (tasks ?? []).filter((t) => t.status === "complete").length,
    failed: (tasks ?? []).filter((t) => t.status === "failed").length,
    cancelled: (tasks ?? []).filter((t) => t.status === "cancelled").length,
  };

  return (
    <div>
      {/* Header */}
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">
          History
        </h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          all tasks across every repo
        </p>
      </header>

      {/* Filters - minimal, inline */}
      <div className="mb-6 flex gap-1">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full px-3 py-1 font-mono text-[10px] tracking-wide transition-all duration-200",
              filter === f
                ? "bg-glass text-text"
                : "text-text-ghost hover:text-text-dim"
            )}
          >
            {f}
            <span className="ml-1.5 text-text-void">
              {counts[f as keyof typeof counts]}
            </span>
          </button>
        ))}
      </div>

      {loading && !tasks ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            loading...
          </span>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title="No tasks found"
          description={
            filter === "all"
              ? "Tasks will appear here after they finish"
              : `No ${filter} tasks`
          }
        />
      ) : (
        <div className="space-y-6">
          {grouped.map(({ label, tasks: groupTasks }) => (
            <div key={label}>
              <SectionDivider label={label} detail={`${groupTasks.length}`} />
              <div className="mt-2 space-y-0.5 stagger">
                {groupTasks.map((task) => (
                  <HistoryRow
                    key={task.id}
                    task={task}
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

function HistoryRow({ task, onClick }: { task: Task; onClick: () => void }) {
  const duration =
    task.completedAt && task.createdAt
      ? formatDurationBetween(task.createdAt, task.completedAt)
      : null;

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-glass animate-fade-up"
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
      {duration && (
        <span className="shrink-0 font-mono text-[10px] text-text-void">
          {duration}
        </span>
      )}
      <StatusBadge status={task.status} />
      <span className="shrink-0 font-mono text-[10px] text-text-void">
        {timeAgo(task.createdAt)}
      </span>
    </button>
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

function formatDurationBetween(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}
