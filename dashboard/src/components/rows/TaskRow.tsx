/** One row in the history / completed-tasks list. */

import { StatusBadge } from "@dashboard/components/StatusBadge";
import { shortId } from "@dashboard/lib/utils";
import { timeAgo, formatDuration } from "@dashboard/lib/format";
import { useNow } from "@dashboard/hooks/use-now";
import { TASK_KIND_CONFIG, type Task } from "@dashboard/lib/api";

interface TaskRowProps {
  task: Task;
  onClick: () => void;
  showDuration?: boolean;
}

export function TaskRow({ task, onClick, showDuration = false }: TaskRowProps) {
  const now = useNow();
  const duration =
    showDuration && task.completedAt && task.createdAt
      ? formatDuration(task.createdAt, task.completedAt)
      : null;

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-glass animate-fade-up"
    >
      <code className="shrink-0 font-mono text-[10px] text-text-void">{shortId(task.id)}</code>
      <span className="shrink-0 font-mono text-[10px] text-accent/60">{task.repo}</span>
      <span className="shrink-0 font-mono text-[9px] text-text-ghost/50">
        {TASK_KIND_CONFIG[task.kind]?.label ?? task.kind}
      </span>
      <span className="flex-1 truncate text-xs text-text-dim group-hover:text-text-secondary transition-colors">
        {task.description}
      </span>
      {duration && <span className="shrink-0 font-mono text-[10px] text-text-void">{duration}</span>}
      <StatusBadge status={task.status} />
      <span className="shrink-0 font-mono text-[10px] text-text-void">{timeAgo(task.createdAt, now)}</span>
      {task.error && (
        <span className="shrink-0 font-mono text-[9px] text-fail/50 max-w-[120px] truncate">
          {task.error}
        </span>
      )}
    </button>
  );
}
