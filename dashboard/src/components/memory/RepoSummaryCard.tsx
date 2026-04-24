/**
 * One tile in the /memory repo grid. Shows freshness, zone/file counts,
 * and the "delete memory" button for registered repos. Unregistered repos
 * render as historical-only with a muted footer.
 */

import type { MemoryStatus } from "@dashboard/lib/api";
import { timeAgo } from "@dashboard/lib/format";

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

export function RepoSummaryCard({ entry, now, deleting, onDelete }: RepoSummaryCardProps) {
  const { repo, registered, status, runCount } = entry;
  const sha = status?.lastIndexedSha?.slice(0, 8);
  const indexedAt = status?.lastIndexedAt ? timeAgo(status.lastIndexedAt, now) : null;
  const zones = status?.zones.length ?? 0;
  const files = status?.fileCount ?? 0;

  return (
    <div className="rounded-lg border border-glass-border bg-glass/40 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="truncate font-mono text-[11px] font-medium text-text">{repo}</span>
        {!registered && (
          <span className="shrink-0 rounded-full border border-glass-border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wide text-text-ghost">
            unregistered
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-void">
          {runCount} run{runCount === 1 ? "" : "s"}
        </span>
        {registered && (
          <button
            onClick={() => void onDelete(repo)}
            disabled={deleting}
            className="shrink-0 rounded-full px-2 py-0.5 font-mono text-[9px] tracking-wide text-text-ghost transition-colors hover:text-fail disabled:cursor-not-allowed disabled:text-text-void"
          >
            {deleting ? "deleting..." : "delete memory"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-text-ghost">
        {registered && status ? (
          <>
            <span className="text-text-dim">{status.status}</span>
            <span className="text-text-void">·</span>
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
    </div>
  );
}
