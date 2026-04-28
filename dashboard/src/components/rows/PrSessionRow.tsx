/** One row in the PR-session list. Stateless: the page owns navigation. */

import { ArrowUpRight } from "lucide-react";
import { cn, shortId } from "@dashboard/lib/utils";
import { prSessionIcon, prSessionIconTitle } from "@dashboard/lib/pr-review";
import { timeAgo } from "@dashboard/lib/format";
import { useNow } from "@dashboard/hooks/use-now";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import type { PrSession } from "@dashboard/lib/api";

interface PrSessionRowProps {
  session: PrSession;
  running: boolean;
  updatingWatch: boolean;
  onClick: () => void;
  onToggleWatch: (session: PrSession) => void;
  onTaskClick?: () => void;
}

export function PrSessionRow({
  session,
  running,
  updatingWatch,
  onClick,
  onToggleWatch,
  onTaskClick,
}: PrSessionRowProps) {
  const now = useNow();
  const Icon = prSessionIcon(session.mode);
  const iconTitle = prSessionIconTitle(session.mode);
  const status = running
    ? "running"
    : session.status === "closed"
      ? "closed"
      : session.watchStatus === "muted"
        ? "muted"
        : session.status;
  const watchLabel = session.watchStatus === "muted" ? "Resume watching" : "Stop watching";

  return (
    <div
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onClick();
      }}
      role="button"
      tabIndex={0}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left",
        "transition-colors hover:bg-glass animate-fade-up",
      )}
    >
      <Icon size={11} className="text-text-ghost shrink-0" aria-label={iconTitle} />
      <span className="font-mono text-[10px] text-accent/60">{session.repo}</span>

      {session.prNumber && (
        <span className="font-mono text-[11px] text-text-dim">#{session.prNumber}</span>
      )}

      {onTaskClick && session.sourceTaskId && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTaskClick();
          }}
          className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost transition-colors hover:text-text-dim"
        >
          {shortId(session.sourceTaskId)}
          <ArrowUpRight size={9} />
        </button>
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

      <StatusBadge status={status} />

      {session.lastPolledAt && !running && session.watchStatus === "watching" && (
        <span title="Last polled" className="font-mono text-[9px] text-text-void">
          polled {timeAgo(session.lastPolledAt, now)}
        </span>
      )}

      {session.status === "active" && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleWatch(session);
          }}
          disabled={updatingWatch}
          className="font-mono text-[10px] text-text-ghost transition-colors hover:text-text-dim disabled:opacity-40"
        >
          {watchLabel}
        </button>
      )}

      <span className="font-mono text-[10px] text-text-void">{timeAgo(session.createdAt, now)}</span>
    </div>
  );
}
