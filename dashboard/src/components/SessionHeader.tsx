/** Title + metadata row at the top of the PR-session detail page. */

import { ArrowUpRight, ExternalLink, Eye, MessageSquare } from "lucide-react";
import { StatusBadge } from "./StatusBadge.js";
import { shortId } from "@dashboard/lib/utils";
import { formatDate, timeAgo } from "@dashboard/lib/format";
import type { PrSessionWithRuns } from "@dashboard/lib/api";

interface SessionHeaderProps {
  session: PrSessionWithRuns;
  running: boolean;
  now: number;
  onOriginTaskClick: (taskId: string) => void;
}

export function SessionHeader({ session, running, now, onOriginTaskClick }: SessionHeaderProps) {
  const Icon = session.originTaskId ? MessageSquare : Eye;

  return (
    <div className="mb-8">
      <div className="flex items-center gap-3 mb-2">
        <Icon size={13} className="text-text-ghost" />
        <span className="font-mono text-[11px] font-medium text-accent">{session.repo}</span>
        {session.prNumber && (
          <span className="font-mono text-[13px] text-text-dim">#{session.prNumber}</span>
        )}
        <StatusBadge status={running ? "running" : session.status} />
      </div>

      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-text-void">
        <span>created {formatDate(session.createdAt)}</span>
        {session.branch && <span>branch: {session.branch}</span>}
        {session.originTaskId && (
          <button
            onClick={() => onOriginTaskClick(session.originTaskId!)}
            className="flex items-center gap-0.5 text-text-ghost hover:text-text-dim transition-colors"
          >
            task {shortId(session.originTaskId)}
            <ArrowUpRight size={9} />
          </button>
        )}
        {session.lastPolledAt && <span>last polled {timeAgo(session.lastPolledAt, now)}</span>}
      </div>

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
