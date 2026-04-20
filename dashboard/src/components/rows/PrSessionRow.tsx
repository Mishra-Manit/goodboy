/** One row in the PR-session list. Stateless: the page owns navigation. */

import { ArrowUpRight, Eye, MessageSquare } from "lucide-react";
import { cn, shortId } from "@dashboard/lib/utils";
import { timeAgo } from "@dashboard/lib/format";
import { useNow } from "@dashboard/hooks/use-now";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import type { PrSession } from "@dashboard/lib/api";

interface PrSessionRowProps {
  session: PrSession;
  running: boolean;
  onClick: () => void;
  onTaskClick?: () => void;
}

export function PrSessionRow({ session, running, onClick, onTaskClick }: PrSessionRowProps) {
  const now = useNow();
  const Icon = session.originTaskId ? MessageSquare : Eye;
  const iconTitle = session.originTaskId ? "Own PR" : "External review";

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left",
        "transition-colors hover:bg-glass animate-fade-up",
      )}
    >
      <Icon size={11} className="text-text-ghost shrink-0" title={iconTitle} />
      <span className="font-mono text-[10px] text-accent/60">{session.repo}</span>

      {session.prNumber && (
        <span className="font-mono text-[11px] text-text-dim">#{session.prNumber}</span>
      )}

      {onTaskClick && session.originTaskId && (
        <span
          onClick={(e) => {
            e.stopPropagation();
            onTaskClick();
          }}
          className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost hover:text-text-dim cursor-pointer"
        >
          {shortId(session.originTaskId)}
          <ArrowUpRight size={9} />
        </span>
      )}

      {session.branch && (
        <span
          title={session.branch}
          className="hidden sm:inline font-mono text-[9px] text-text-void truncate max-w-[200px]"
        >
          {session.branch}
        </span>
      )}

      <span className="flex-1" />

      <StatusBadge status={running ? "running" : session.status} />

      {session.lastPolledAt && !running && (
        <span title="Last polled" className="font-mono text-[9px] text-text-void">
          polled {timeAgo(session.lastPolledAt, now)}
        </span>
      )}

      <span className="font-mono text-[10px] text-text-void">{timeAgo(session.createdAt, now)}</span>
    </button>
  );
}
