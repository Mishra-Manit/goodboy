/** Compact PR row card with state badge, actions, and pipeline progress. */

import { type ReactNode } from "react";
import type { PrInboxRow, TaskWithStages } from "@dashboard/lib/api";
import { Card } from "@dashboard/components/Card";
import { PipelineProgress } from "@dashboard/components/PipelineProgress";
import { cn, shortId } from "@dashboard/lib/utils";
import { timeAgo } from "@dashboard/lib/format";
import { TinyBadge } from "./TinyBadge.js";
import { PrStateBadge } from "./PrStateBadge.js";
import { WatchButton } from "./WatchButton.js";
import { ActionButton } from "./ActionButton.js";

interface PrInboxCardProps {
  row: PrInboxRow;
  now: number;
  detail: TaskWithStages | undefined;
  actionKey: string | null;
  watchUpdating: boolean;
  closing: boolean;
  onOpen: () => void;
  onToggleWatch: () => Promise<void>;
  onStart: () => Promise<void>;
  onRetry: () => Promise<void>;
  onRerun: () => Promise<void>;
  onClose: () => Promise<void>;
}

export function PrInboxCard({
  row,
  now,
  detail,
  actionKey,
  watchUpdating,
  closing,
  onOpen,
  onToggleWatch,
  onStart,
  onRetry,
  onRerun,
  onClose,
}: PrInboxCardProps) {
  const activeAction = actionKey?.startsWith(`${row.repo}#${row.number}:`) ?? false;

  return (
    <Card live={row.state === "review_running"} className="animate-fade-up">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[10px] text-text-ghost">#{row.number}</span>
            <PrStateBadge state={row.state} />
            {row.isDraft && <TinyBadge tone="warn">draft</TinyBadge>}
            {row.reviewDecision && <TinyBadge>{row.reviewDecision.toLowerCase()}</TinyBadge>}
            <span className="font-mono text-[10px] text-text-void">{timeAgo(row.updatedAt, now)}</span>
            <WatchButton row={row} updating={watchUpdating} onToggle={onToggleWatch} />
          </div>
          <button type="button" onClick={onOpen} className="mt-2 block min-w-0 text-left">
            <span className="line-clamp-2 text-[13px] leading-relaxed text-text-secondary transition-colors hover:text-text">
              {row.title}
            </span>
            <span className="mt-1 block font-mono text-[10px] text-text-ghost">
              {row.author} · {row.headRef} → {row.baseRef}
            </span>
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {renderAction(row, activeAction, onStart, onRetry, onRerun)}
          <button
            type="button"
            disabled={closing}
            onClick={onClose}
            title="Close PR on GitHub"
            className={cn(
              "rounded-full border px-3 py-1.5 font-mono text-[10px] transition-colors",
              closing
                ? "cursor-wait border-glass-border text-text-void"
                : "border-fail/30 text-fail hover:border-fail hover:bg-glass-hover",
            )}
          >
            {closing ? "closing..." : "close pr"}
          </button>
        </div>
      </div>

      {row.labels.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {row.labels.map((label) => <TinyBadge key={label}>{label}</TinyBadge>)}
        </div>
      )}

      {detail && row.state === "review_running" && (
        <div className="mt-4 flex items-center justify-between">
          <code className="font-mono text-[10px] text-text-ghost">{shortId(detail.id)}</code>
          <PipelineProgress stages={detail.stages} kind={detail.kind} className="hidden sm:flex" />
          <PipelineProgress stages={detail.stages} kind={detail.kind} mini className="flex sm:hidden" />
        </div>
      )}
    </Card>
  );
}

function renderAction(
  row: PrInboxRow,
  active: boolean,
  onStart: () => Promise<void>,
  onRetry: () => Promise<void>,
  onRerun: () => Promise<void>,
): ReactNode {
  if (row.canRetryReview) return <ActionButton busy={active} onClick={onRetry}>Retry review</ActionButton>;
  if (row.canRerunReview) return <ActionButton busy={active} onClick={onRerun}>Re-run review</ActionButton>;
  if (row.canStartReview) {
    return <ActionButton busy={active} onClick={onStart}>{row.state === "owned" ? "Review owned PR" : "Start review"}</ActionButton>;
  }
  return null;
}
