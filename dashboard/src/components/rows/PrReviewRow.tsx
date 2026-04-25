/** History row for a completed PR review task. */

import { ExternalLink } from "lucide-react";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { useNow } from "@dashboard/hooks/use-now";
import { formatDuration, timeAgo } from "@dashboard/lib/format";
import { getPrReviewTarget, getPrReviewUrl } from "@dashboard/lib/pr-review";
import { shortId } from "@dashboard/lib/utils";
import type { Task } from "@dashboard/lib/api";

interface PrReviewRowProps {
  task: Task;
  onClick: () => void;
}

export function PrReviewRow({ task, onClick }: PrReviewRowProps) {
  const now = useNow();
  const duration = task.completedAt ? formatDuration(task.createdAt, task.completedAt) : null;
  const prUrl = getPrReviewUrl(task);

  return (
    <div className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-glass animate-fade-up">
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <code className="shrink-0 font-mono text-[10px] text-text-void">{shortId(task.id)}</code>
        <span className="shrink-0 font-mono text-[10px] text-accent/60">{task.repo}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-text-dim transition-colors group-hover:text-text-secondary">
          {getPrReviewTarget(task)}
        </span>
        {duration && <span className="shrink-0 font-mono text-[10px] text-text-void">{duration}</span>}
        <StatusBadge status={task.status} />
        <span className="shrink-0 font-mono text-[10px] text-text-void">{timeAgo(task.createdAt, now)}</span>
        {task.error && (
          <span className="max-w-[120px] shrink-0 truncate font-mono text-[9px] text-fail/50">
            {task.error}
          </span>
        )}
      </button>
      {prUrl && (
        <a
          href={prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 font-mono text-[10px] text-text-ghost transition-colors hover:text-accent"
          aria-label="Open pull request"
        >
          <ExternalLink size={10} />
        </a>
      )}
    </div>
  );
}
