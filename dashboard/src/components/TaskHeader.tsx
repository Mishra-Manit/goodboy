/** Title + metadata + action row at the top of the task detail page. */

import { ExternalLink, RotateCcw, XCircle } from "lucide-react";
import { StatusBadge } from "./StatusBadge.js";
import { TASK_KIND_CONFIG, type TaskWithStages } from "@dashboard/lib/api";
import { formatDate, timeAgo } from "@dashboard/lib/format";
import { getPrReviewTarget, getPrReviewUrl } from "@dashboard/lib/pr-review";
import { shortId } from "@dashboard/lib/utils";

interface TaskHeaderProps {
  task: TaskWithStages;
  now: number;
  isActive: boolean;
  retrying?: boolean;
  cancelling?: boolean;
  onRetry: () => void;
  onCancel: () => void;
}

export function TaskHeader({
  task,
  now,
  isActive,
  retrying = false,
  cancelling = false,
  onRetry,
  onCancel,
}: TaskHeaderProps) {
  const kindConfig = TASK_KIND_CONFIG[task.kind] ?? TASK_KIND_CONFIG.coding_task;
  const prReviewUrl = getPrReviewUrl(task);
  const prReviewTarget = getPrReviewTarget(task);

  return (
    <header className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <code className="font-mono text-[11px] text-text-ghost">{shortId(task.id)}</code>
        <span className="font-mono text-[11px] font-medium text-accent">{task.repo}</span>
        <span className="font-mono text-[10px] text-text-ghost/50">{kindConfig.label}</span>
        <StatusBadge status={task.status} />
      </div>

      <p className="text-[15px] text-text leading-relaxed">{task.description}</p>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-text-void">
        <span>created {formatDate(task.createdAt)}</span>
        {task.completedAt && <span>completed {timeAgo(task.completedAt, now)}</span>}
        {task.branch && <span>branch: {task.branch}</span>}
      </div>

      <div className="mt-3 flex gap-2">
        {task.prUrl && (
          <a
            href={task.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-accent"
          >
            <ExternalLink size={10} />
            PR #{task.prNumber}
          </a>
        )}
        {!task.prUrl && prReviewUrl && (
          <a
            href={prReviewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-accent"
          >
            <ExternalLink size={10} />
            {prReviewTarget}
          </a>
        )}
        {task.status === "failed" && (
          <ActionButton
            icon={<RotateCcw size={10} />}
            label={retrying ? "retrying" : "retry"}
            onClick={onRetry}
            disabled={retrying}
          />
        )}
        {isActive && (
          <ActionButton
            icon={<XCircle size={10} />}
            label={cancelling ? "cancelling" : "cancel"}
            onClick={onCancel}
            disabled={cancelling}
            danger
          />
        )}
      </div>
    </header>
  );
}

// --- Helpers ---

interface ActionButtonProps {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}

function ActionButton({ icon, label, onClick, disabled = false, danger }: ActionButtonProps) {
  const color = danger ? "text-fail/60 hover:text-fail" : "text-text-ghost hover:text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center gap-1.5 font-mono text-[10px] ${color} transition-colors disabled:cursor-wait disabled:opacity-60`}
    >
      {icon}
      {label}
    </button>
  );
}
