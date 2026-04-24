/** Thin history row for one memory run. Click to open /memory/:id. */

import { StatusBadge } from "@dashboard/components/StatusBadge";
import { useNow } from "@dashboard/hooks/use-now";
import { type MemoryRun } from "@dashboard/lib/api";
import { formatDuration, timeAgo } from "@dashboard/lib/format";
import { KIND_TONE } from "@dashboard/lib/memory-ui";
import { isTestInstance } from "@dashboard/shared";
import { cn, shortId } from "@dashboard/lib/utils";

interface MemoryRunRowProps {
  run: MemoryRun;
  onClick: () => void;
  /** Show the repo name as a column. Enable when the list spans multiple repos. */
  showRepo?: boolean;
}

export function MemoryRunRow({ run, onClick, showRepo }: MemoryRunRowProps) {
  const now = useNow();
  const isTest = isTestInstance(run.instance);
  const duration = run.completedAt ? formatDuration(run.startedAt, run.completedAt) : null;
  const subtitle = run.externalLabel ?? (run.originTaskId ? `task ${shortId(run.originTaskId)}` : null);

  return (
    <button
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-glass animate-fade-up"
    >
      <span className={cn("shrink-0 font-mono text-[10px] uppercase tracking-wide", KIND_TONE[run.kind])}>
        {run.kind}
      </span>
      <StatusBadge status={run.status} />
      {showRepo && (
        <span className="shrink-0 font-mono text-[11px] font-medium text-accent">{run.repo}</span>
      )}
      {isTest && (
        <span className="shrink-0 rounded-full border border-glass-border px-2 py-0.5 font-mono text-[9px] text-text-ghost">
          TEST
        </span>
      )}
      {run.sha && <span className="shrink-0 font-mono text-[10px] text-text-dim">{run.sha.slice(0, 8)}</span>}
      {run.zoneCount !== null && (
        <span className="shrink-0 font-mono text-[10px] text-text-ghost">
          {run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}
        </span>
      )}
      {subtitle && (
        <span className="flex-1 truncate font-mono text-[10px] text-text-ghost group-hover:text-text-dim transition-colors">
          {subtitle}
        </span>
      )}
      {!subtitle && <span className="flex-1" />}
      {run.error && (
        <span className="shrink-0 max-w-[160px] truncate font-mono text-[9px] text-fail/50">
          {run.error}
        </span>
      )}
      {duration && <span className="shrink-0 font-mono text-[10px] text-text-void tabular-nums">{duration}</span>}
      <span className="shrink-0 font-mono text-[10px] text-text-void">{timeAgo(run.startedAt, now)}</span>
    </button>
  );
}
