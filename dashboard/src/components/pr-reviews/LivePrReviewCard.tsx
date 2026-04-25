/** Live PR review task card with pipeline progress. */

import { ExternalLink } from "lucide-react";
import { Card } from "@dashboard/components/Card";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { timeAgo } from "@dashboard/lib/format";
import { getPrReviewTarget, getPrReviewUrl } from "@dashboard/lib/pr-review";
import { shortId } from "@dashboard/lib/utils";
import type { Task, TaskWithStages } from "@dashboard/lib/api";

interface LivePrReviewCardProps {
  task: Task;
  detail: TaskWithStages | undefined;
  now: number;
  onClick: () => void;
}

export function LivePrReviewCard({ task, detail, now, onClick }: LivePrReviewCardProps) {
  const prUrl = getPrReviewUrl(task);
  const prTarget = getPrReviewTarget(task);

  return (
    <div className="animate-fade-up">
      <Card hoverable live>
        <div className="flex items-start gap-3">
          <button onClick={onClick} className="min-w-0 flex-1 text-left">
            <div className="mb-2 flex items-center gap-3">
              <code className="font-mono text-[10px] text-text-ghost">{shortId(task.id)}</code>
              <span className="font-mono text-[11px] font-medium text-accent">{task.repo}</span>
              <StatusBadge status={task.status} />
              <span className="ml-auto font-mono text-[10px] text-text-void">{timeAgo(task.createdAt, now)}</span>
            </div>

            <p className="truncate text-[13px] text-text-secondary">{prTarget}</p>

            {detail && (
              <div className="mt-3 flex items-center justify-between">
                <PipelineProgress stages={detail.stages} kind={task.kind} className="hidden sm:flex" />
                <PipelineProgress stages={detail.stages} kind={task.kind} mini className="flex sm:hidden" />
              </div>
            )}
          </button>

          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 flex shrink-0 items-center gap-1 font-mono text-[10px] text-text-ghost transition-colors hover:text-accent"
            >
              <ExternalLink size={10} />
              view
            </a>
          )}
        </div>
      </Card>
    </div>
  );
}
