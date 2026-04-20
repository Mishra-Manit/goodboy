/** Task-derived PR row (one per coding task that opened a PR). */

import { useState } from "react";
import { ExternalLink, ArrowUpRight, X } from "lucide-react";
import { shortId } from "@dashboard/lib/utils";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { dismissTask, type PR } from "@dashboard/lib/api";

interface PrRowProps {
  pr: PR;
  onTaskClick: () => void;
  onDismiss: () => void;
}

export function PrRow({ pr, onTaskClick, onDismiss }: PrRowProps) {
  const [dismissing, setDismissing] = useState(false);
  const canDismiss = pr.status !== "running" && pr.status !== "queued";

  async function handleDismiss(e: React.MouseEvent) {
    e.stopPropagation();
    if (!canDismiss || dismissing) return;
    setDismissing(true);
    try {
      await dismissTask(pr.taskId);
      onDismiss();
    } catch {
      setDismissing(false);
    }
  }

  return (
    <div className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-glass animate-fade-up">
      <span className="font-mono text-[10px] text-accent/60">{pr.repo}</span>

      <button
        onClick={onTaskClick}
        className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
      >
        {shortId(pr.taskId)}
        <ArrowUpRight size={9} />
      </button>

      {pr.prNumber && <span className="font-mono text-[11px] text-text-dim">#{pr.prNumber}</span>}

      <span className="flex-1" />

      <StatusBadge status={pr.status} />

      {pr.prUrl && (
        <a
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
        >
          <ExternalLink size={10} />
          view
        </a>
      )}

      {canDismiss && (
        <button
          onClick={handleDismiss}
          disabled={dismissing}
          className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-fail transition-colors disabled:opacity-40"
          title="Close PR and clean up"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
