import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { History } from "lucide-react";
import { fetchTasks, type Task } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card, CardHeader } from "@dashboard/components/Card";
import { EmptyState } from "@dashboard/components/EmptyState";
import { shortId, formatDate } from "@dashboard/lib/utils";

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

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Task History</h1>
          <p className="text-sm text-text-muted">
            All completed, failed, and cancelled tasks
          </p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="mb-4 flex gap-1 rounded-lg bg-surface-raised p-1 w-fit">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              filter === f
                ? "bg-surface-overlay text-text"
                : "text-text-dim hover:text-text"
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading && !tasks ? (
        <div className="text-sm text-text-muted">Loading...</div>
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
  return (
    <Card hoverable onClick={onClick} className="py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <code className="shrink-0 text-xs text-text-muted">
            {shortId(task.id)}
          </code>
          <span className="shrink-0 text-xs font-medium text-brand">
            {task.repo}
          </span>
          <span className="truncate text-sm text-text-dim">
            {task.description}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-text-muted">
            {formatDate(task.createdAt)}
          </span>
          <StatusBadge status={task.status} />
        </div>
      </div>
      {task.error && (
        <div className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-400 truncate">
          {task.error}
        </div>
      )}
    </Card>
  );
}
