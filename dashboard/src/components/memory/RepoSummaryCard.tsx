/**
 * One tile in the /memory repo grid. Shows freshness, zone/file counts,
 * and the "delete memory" button for registered repos. Unregistered repos
 * render as historical-only with a muted footer.
 */

import { useNavigate } from "react-router-dom";
import { Brain } from "lucide-react";
import type { MemoryStatus, MemoryStatusKind } from "@dashboard/lib/api";
import { timeAgo } from "@dashboard/lib/format";
import { cn } from "@dashboard/lib/utils";

export interface RepoEntry {
  repo: string;
  registered: boolean;
  status: MemoryStatus | undefined;
  runCount: number;
}

interface RepoSummaryCardProps {
  entry: RepoEntry;
  now: number;
  deleting: boolean;
  onDelete: (repo: string) => Promise<void>;
}

const STATUS_COLOR: Record<MemoryStatusKind, string> = {
  fresh: "text-accent",
  stale: "text-warn",
  missing: "text-text-ghost",
};

export function RepoSummaryCard({ entry, now, deleting, onDelete }: RepoSummaryCardProps) {
  const { repo, registered, status, runCount } = entry;
  const sha = status?.lastIndexedSha?.slice(0, 8);
  const indexedAt = status?.lastIndexedAt ? timeAgo(status.lastIndexedAt, now) : null;
  const zones = status?.zones.length ?? 0;
  const files = status?.fileCount ?? 0;
  const navigate = useNavigate();

  return (
    <div className="rounded-lg border border-glass-border bg-glass/40 px-3 py-3 transition-colors duration-150 hover:border-glass-hover hover:bg-glass-hover/30">

      {/* Repo name row */}
      <div className="mb-2 flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-semibold text-text">
          {repo}
        </span>
        {!registered && (
          <span className="shrink-0 rounded-full border border-glass-border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-text-ghost">
            unregistered
          </span>
        )}
        {registered && status && (
          <span className={cn("shrink-0 font-mono text-[9px] uppercase tracking-wide", STATUS_COLOR[status.status])}>
            {status.status}
          </span>
        )}
      </div>

      {/* Stats row */}
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-ghost">
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

      {/* Footer: run count + actions */}
      <div className="flex items-center gap-1 border-t border-glass-border/50 pt-2">
        <span className="font-mono text-[9px] text-text-void">
          {runCount} run{runCount === 1 ? "" : "s"}
        </span>
        <div className="ml-auto flex items-center gap-1">
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
              className="rounded-full px-2.5 py-1 font-mono text-[9px] tracking-wide text-text-ghost transition-colors hover:text-fail disabled:cursor-not-allowed disabled:text-text-void"
            >
              {deleting ? "deleting..." : "delete"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
