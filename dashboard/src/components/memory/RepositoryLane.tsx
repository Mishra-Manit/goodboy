/**
 * Repository-scoped memory lane. Keeps repo status, actions, live runs,
 * and historical run metadata together so /memory stays scan-friendly.
 */

import { Brain, Trash2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import type { MemoryRun, MemoryStatusKind } from "@dashboard/lib/api";
import { formatDuration, timeAgo } from "@dashboard/lib/format";
import { KIND_TONE } from "@dashboard/lib/memory-ui";
import { cn, shortId } from "@dashboard/lib/utils";
import { isTestInstance } from "@dashboard/shared";
import type { RepoEntry } from "./RepoSummaryCard.js";

interface RepositoryLaneProps {
  entry: RepoEntry;
  runs: MemoryRun[];
  now: number;
  deleting: boolean;
  onDelete: (repo: string) => Promise<void>;
  onOpenRun: (run: MemoryRun) => void;
}

const STATUS_TONE: Record<MemoryStatusKind, string> = {
  fresh: "text-accent",
  stale: "text-warn",
  missing: "text-text-ghost",
};

/** Render one repo lane with all memory information for that repo. */
export function RepositoryLane({ entry, runs, now, deleting, onDelete, onOpenRun }: RepositoryLaneProps) {
  const navigate = useNavigate();
  const { repo, registered, status, runCount } = entry;
  const hasActiveRun = runs.some((run) => run.status === "running");
  const sha = status?.lastIndexedSha?.slice(0, 8);
  const indexedAt = status?.lastIndexedAt ? timeAgo(status.lastIndexedAt, now) : null;
  const zones = status?.zones.length ?? 0;
  const files = status?.fileCount ?? 0;

  return (
    <article
      className={cn(
        "flex h-[34rem] min-h-0 flex-col rounded-lg border bg-glass/40 p-3 transition-colors duration-150",
        hasActiveRun ? "border-accent-dim bg-accent-ghost/40" : "border-glass-border",
      )}
    >
      <header className="border-b border-glass-border/50 pb-3">
        <div className="flex min-w-0 items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-mono text-[11px] font-semibold text-text">{repo}</h2>
            <RepoStateLine registered={registered} status={status?.status} />
          </div>
          <span className="shrink-0 font-mono text-[9px] text-text-ghost">
            {runCount} run{runCount === 1 ? "" : "s"}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] text-text-ghost">
          {registered && status ? (
            <>
              <span>{zones}z</span>
              <span className="text-text-void">·</span>
              <span>{files}f</span>
              {sha && (
                <>
                  <span className="text-text-void">·</span>
                  <span className="text-text-dim">{sha}</span>
                </>
              )}
              {indexedAt && (
                <>
                  <span className="text-text-void">·</span>
                  <span>{indexedAt}</span>
                </>
              )}
            </>
          ) : registered ? (
            <span className="text-text-void">loading...</span>
          ) : (
            <span className="text-text-void">historical runs only</span>
          )}
        </div>

        <div className="mt-3 flex items-center gap-1">
          <button
            onClick={() => navigate(`/memory/feedback/${encodeURIComponent(repo)}`)}
            className="flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[9px] tracking-wide text-text-ghost transition-all duration-200 hover:bg-accent/8 hover:text-accent"
            title="View reviewer memory rules"
          >
            <Brain size={9} />
            rules
          </button>
          {registered && (
            <button
              onClick={() => void onDelete(repo)}
              disabled={deleting}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[9px] tracking-wide text-text-ghost transition-colors hover:text-fail disabled:cursor-not-allowed disabled:text-text-void"
              title="Delete memory for this repo"
            >
              <Trash2 size={9} />
              {deleting ? "deleting..." : "delete"}
            </button>
          )}
        </div>
      </header>

      <div className="scrollbar-none mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain">
        {runs.length === 0 ? (
          <div className="rounded-md border border-glass-border px-3 py-2 font-mono text-[9px] text-text-void">
            no visible runs
          </div>
        ) : (
          runs.map((run) => (
            <MemoryRunLaneCard key={run.id} run={run} now={now} onClick={() => onOpenRun(run)} />
          ))
        )}
      </div>
    </article>
  );
}

interface RepoStateLineProps {
  registered: boolean;
  status: MemoryStatusKind | undefined;
}

function RepoStateLine({ registered, status }: RepoStateLineProps) {
  if (!registered) {
    return (
      <p className="mt-1 font-mono text-[9px] uppercase tracking-wide text-text-ghost">
        unregistered
      </p>
    );
  }

  if (!status) {
    return <p className="mt-1 font-mono text-[9px] text-text-void">loading...</p>;
  }

  return (
    <p className={cn("mt-1 font-mono text-[9px] uppercase tracking-wide", STATUS_TONE[status])}>
      {status}
    </p>
  );
}

interface MemoryRunLaneCardProps {
  run: MemoryRun;
  now: number;
  onClick: () => void;
}

function MemoryRunLaneCard({ run, now, onClick }: MemoryRunLaneCardProps) {
  const isTest = isTestInstance(run.instance);
  const duration = run.completedAt ? formatDuration(run.startedAt, run.completedAt) : null;
  const subtitle = run.externalLabel ?? (run.originTaskId ? `task ${shortId(run.originTaskId)}` : null);

  return (
    <button
      onClick={onClick}
      className={cn(
        "group rounded-md border px-3 py-2 text-left transition-colors duration-150 animate-fade-up",
        run.status === "running"
          ? "border-accent-dim bg-accent-ghost hover:bg-accent-ghost"
          : "border-glass-border bg-bg-hover/50 hover:bg-glass-hover/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn("shrink-0 font-mono text-[10px] uppercase tracking-wide", KIND_TONE[run.kind])}>
          {run.kind}
        </span>
        <StatusBadge status={run.status} />
        {isTest && (
          <span className="shrink-0 rounded-full border border-glass-border px-1.5 py-0.5 font-mono text-[8px] text-text-ghost">
            TEST
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[9px] text-text-void">
          {timeAgo(run.startedAt, now)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[9px] text-text-ghost">
        {run.sha && <span className="text-text-dim">{run.sha.slice(0, 8)}</span>}
        {run.zoneCount !== null && (
          <span>{run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}</span>
        )}
        {subtitle && (
          <span className="min-w-0 max-w-full truncate group-hover:text-text-dim">{subtitle}</span>
        )}
        {duration && <span className="text-text-void tabular-nums">{duration}</span>}
      </div>

      {run.error && (
        <p className="mt-1 truncate font-mono text-[9px] text-fail/70">{run.error}</p>
      )}
    </button>
  );
}
