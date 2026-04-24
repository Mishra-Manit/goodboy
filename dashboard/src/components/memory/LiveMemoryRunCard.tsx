/** Clickable card for an in-flight memory run. Shown in the "live" section of /memory. */

import { Card } from "@dashboard/components/Card";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import type { MemoryRun } from "@dashboard/lib/api";
import { KIND_TONE } from "@dashboard/lib/memory-ui";
import { timeAgo } from "@dashboard/lib/format";
import { cn, shortId } from "@dashboard/lib/utils";

interface LiveMemoryRunCardProps {
  run: MemoryRun;
  now: number;
  onClick: () => void;
}

export function LiveMemoryRunCard({ run, now, onClick }: LiveMemoryRunCardProps) {
  const subtitle = run.externalLabel ?? (run.originTaskId ? `task ${shortId(run.originTaskId)}` : null);

  return (
    <div className="animate-fade-up">
      <Card hoverable live onClick={onClick}>
        <div className="mb-2 flex items-center gap-3">
          <span className={cn("font-mono text-[10px] uppercase tracking-wide", KIND_TONE[run.kind])}>
            {run.kind}
          </span>
          <span className="font-mono text-[11px] font-medium text-accent">{run.repo}</span>
          <StatusBadge status={run.status} />
          <span className="ml-auto font-mono text-[10px] text-text-void">
            {timeAgo(run.startedAt, now)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10px] text-text-ghost">
          {run.sha && <span className="text-text-dim">{run.sha.slice(0, 8)}</span>}
          {run.zoneCount !== null && (
            <span>{run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}</span>
          )}
          {subtitle && <span>{subtitle}</span>}
        </div>
      </Card>
    </div>
  );
}
