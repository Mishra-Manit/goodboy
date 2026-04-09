import { useNavigate } from "react-router-dom";
import { ListTodo } from "lucide-react";
import { fetchTasks, type Task } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { Card, CardHeader } from "@dashboard/components/Card";
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

  useSSERefresh(refetch, (e) => e.type === "task_update");

  const activeTasks = (tasks ?? []).filter((t) => ACTIVE_STATUSES.has(t.status));

  return (
    <div className="p-6">
      <div className="mb-6">
        <h1 className="text-lg font-semibold">Active Tasks</h1>
        <p className="text-sm text-text-muted">
          Currently running tasks and their progress
        </p>
      </div>

      {loading && !tasks ? (
        <div className="text-sm text-text-muted">Loading...</div>
      ) : activeTasks.length === 0 ? (
        <EmptyState
          icon={<ListTodo size={32} />}
          title="No active tasks"
          description="Send a task via Telegram to get started"
        />
      ) : (
        <div className="space-y-3">
          {activeTasks.map((task) => (
            <TaskCard
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

function TaskCard({ task, onClick }: { task: Task; onClick: () => void }) {
  return (
    <Card hoverable onClick={onClick}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <code className="text-xs text-text-muted">{shortId(task.id)}</code>
          <span className="text-xs text-text-muted">{task.repo}</span>
        </div>
        <StatusBadge status={task.status} />
      </CardHeader>
      <p className="text-sm text-text-dim line-clamp-2">{task.description}</p>
      <div className="mt-2 text-xs text-text-muted">
        Started {timeAgo(task.createdAt)}
      </div>
    </Card>
  );
}
