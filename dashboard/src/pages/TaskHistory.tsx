import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { History, Clock } from "lucide-react";
import { fetchTasks, type Task } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { shortId, formatDate, timeAgo } from "@dashboard/lib/utils";

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

  const counts = {
    all: (tasks ?? []).length,
    complete: (tasks ?? []).filter((t) => t.status === "complete").length,
    failed: (tasks ?? []).filter((t) => t.status === "failed").length,
    cancelled: (tasks ?? []).filter((t) => t.status === "cancelled").length,
  };

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <History size={18} className="text-zinc-500" />
          <h1 className="text-lg font-semibold text-zinc-100">Task History</h1>
        </div>
        <p className="text-sm text-zinc-500">
          All tasks across every repo
        </p>
      </div>

      {/* Filter tabs */}
      <div className="mb-4 flex gap-1 rounded-lg bg-zinc-900 p-1 w-fit">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f
                ? "bg-zinc-800 text-zinc-200 shadow-sm"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
            <span className="text-[10px] text-zinc-600">
              {counts[f as keyof typeof counts]}
            </span>
          </button>
        ))}
      </div>

      {loading && !tasks ? (
        <div className="text-sm text-zinc-500">Loading...</div>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<History size={32} />}
          title="No tasks found"
          description={
            filter === "all"
              ? "Tasks will appear here after they finish"
              : `No ${filter} tasks`
          }
        />
      ) : (
        <div className="space-y-2">
          {filtered.map((task) => (
            <HistoryRow
              key={task.id}
              task={task}
              onClick={() => navigate(`/tasks/${task.id}`)}
            />
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
    <Card hoverable onClick={onClick} className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <code className="shrink-0 text-xs text-zinc-600 font-mono">
            {shortId(task.id)}
          </code>
          <span className="shrink-0 text-xs font-medium text-violet-400">
            {task.repo}
          </span>
          <span className="truncate text-sm text-zinc-400">
            {task.description}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {duration && (
            <span className="flex items-center gap-1 text-[11px] text-zinc-600">
              <Clock size={10} />
              {duration}
            </span>
          )}
          <span className="text-[11px] text-zinc-600">
            {timeAgo(task.createdAt)}
          </span>
          <StatusBadge status={task.status} />
        </div>
      </div>
      {task.error && (
        <div className="mt-2 rounded-md bg-red-500/5 border border-red-500/10 px-2.5 py-1.5 text-xs text-red-400/80 truncate">
          {task.error}
        </div>
      )}
    </Card>
  );
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
