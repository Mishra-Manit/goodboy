/** Collapsible card for one run inside a PR session. */

import { cn } from "@dashboard/lib/utils";
import { timeAgo, formatDuration } from "@dashboard/lib/format";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { LogViewer } from "@dashboard/components/log-viewer";
import type { LogEntry, PrSessionRun } from "@dashboard/lib/api";

const TRIGGER_LABELS: Record<string, string> = {
  pr_creation: "PR creation",
  comments: "Comment feedback",
  external_review: "External review",
};

interface RunCardProps {
  run: PrSessionRun;
  expanded: boolean;
  onToggle: () => void;
  logs: LogEntry[];
  isLive: boolean;
  now: number;
}

export function RunCard({ run, expanded, onToggle, logs, isLive, now }: RunCardProps) {
  const triggerLabel = TRIGGER_LABELS[run.trigger] ?? run.trigger;
  const duration =
    run.completedAt && run.startedAt ? formatDuration(run.startedAt, run.completedAt) : null;

  return (
    <div className={cn("rounded-lg border border-glass-border bg-glass transition-all", isLive && "live-glow")}>
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-glass-hover transition-colors rounded-lg"
      >
        <span className="font-mono text-[11px] font-medium text-text">{triggerLabel}</span>
        <StatusBadge status={run.status} />
        {duration && (
          <span className="font-mono text-[10px] text-text-void tabular-nums">{duration}</span>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-text-void">{timeAgo(run.startedAt, now)}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 animate-fade-up">
          {run.error && (
            <div className="mb-3 rounded-md bg-fail-dim px-3 py-2">
              <p className="font-mono text-[11px] text-fail/70 whitespace-pre-wrap">{run.error}</p>
            </div>
          )}

          {run.trigger === "comments" && run.comments && run.comments.length > 0 && (
            <div className="mb-3">
              <span className="font-mono text-[9px] uppercase tracking-wider text-text-ghost block mb-2">
                triggering comments
              </span>
              <div className="space-y-2">
                {run.comments.map((c, i) => (
                  <div key={i} className="rounded-md bg-bg-raised px-3 py-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-[10px] font-medium text-text-dim">@{c.author}</span>
                      {c.path && (
                        <span className="font-mono text-[9px] text-text-void">
                          {c.path}
                          {c.line ? `:${c.line}` : ""}
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-text-secondary whitespace-pre-wrap leading-relaxed">
                      {c.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          <LogViewer entries={logs} maxHeight="400px" autoScroll={isLive} />
        </div>
      )}
    </div>
  );
}
