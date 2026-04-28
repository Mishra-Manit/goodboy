/** Title + metadata row at the top of the PR-session detail page. */

import { ArrowUpRight, ExternalLink, Eye, MessageSquare } from "lucide-react";
import { StatusBadge } from "./StatusBadge.js";
import { shortId } from "@dashboard/lib/utils";
import { formatDate, timeAgo } from "@dashboard/lib/format";
import type { PrSessionWithRuns } from "@dashboard/lib/api";

interface SessionHeaderProps {
  session: PrSessionWithRuns;
  running: boolean;
  updatingWatch: boolean;
  now: number;
  onSourceTaskClick: (taskId: string) => void;
  onToggleWatch: (session: PrSessionWithRuns) => void;
}

export function SessionHeader({
  session,
  running,
  updatingWatch,
  now,
  onSourceTaskClick,
  onToggleWatch,
}: SessionHeaderProps) {
  const Icon = session.mode === "own" ? MessageSquare : Eye;
  const status = running
    ? "running"
    : session.status === "closed"
      ? "closed"
      : session.watchStatus === "muted"
        ? "muted"
        : session.status;
  const watchLabel = session.watchStatus === "muted" ? "Resume watching" : "Stop watching";

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <Icon size={13} className="text-text-ghost" />
        <span className="font-mono text-[11px] font-medium text-accent">{session.repo}</span>
        {session.prNumber && (
          <span className="font-mono text-[13px] text-text-dim">#{session.prNumber}</span>
        )}
        <StatusBadge status={status} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-text-void">
        <span>created {formatDate(session.createdAt)}</span>
        {session.branch && <span>branch: {session.branch}</span>}
        {session.sourceTaskId && (
          <button
            onClick={() => onSourceTaskClick(session.sourceTaskId!)}
            className="flex items-center gap-0.5 text-text-ghost hover:text-text-dim transition-colors"
          >
            task {shortId(session.sourceTaskId)}
            <ArrowUpRight size={9} />
          </button>
        )}
        {session.lastPolledAt && session.watchStatus === "watching" && (
          <span>last polled {timeAgo(session.lastPolledAt, now)}</span>
        )}
      </div>

      {session.status === "active" && (
        <button
          onClick={() => onToggleWatch(session)}
          disabled={updatingWatch}
          className="mt-2 font-mono text-[10px] text-text-ghost transition-colors hover:text-text-dim disabled:opacity-40"
        >
          {watchLabel}
        </button>
      )}

      {session.prUrl && (
        <a
          href={session.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
        >
          <ExternalLink size={10} />
          view on GitHub
        </a>
      )}
    </div>
  );
}
