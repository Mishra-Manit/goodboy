import { useState } from "react";
import { ExternalLink, ArrowUpRight, X, Eye, MessageSquare } from "lucide-react";
import {
  fetchPRs,
  fetchPrSessions,
  dismissTask,
  type PR,
  type PrSession,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { shortId, timeAgo, cn } from "@dashboard/lib/utils";
import { useNavigate } from "react-router-dom";

export function PullRequests() {
  const navigate = useNavigate();
  const { data: prs, loading: prsLoading, refetch: refetchPrs } = useQuery(() => fetchPRs());
  const { data: sessions, loading: sessionsLoading, refetch: refetchSessions } = useQuery(() => fetchPrSessions());

  const refetchAll = () => { refetchPrs(); refetchSessions(); };
  useSSERefresh(refetchAll, (e) => e.type === "pr_update" || e.type === "task_update");

  const activeSessions = (sessions ?? []).filter((s) => s.status === "active");
  const closedSessions = (sessions ?? []).filter((s) => s.status === "closed");

  const loading = prsLoading || sessionsLoading;

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">
          Pull Requests
        </h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          PRs created by goodboy and active review sessions
        </p>
      </header>

      {loading && !prs && !sessions ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
            loading...
          </span>
        </div>
      ) : (
        <>
          {/* ── Active PR Sessions ── */}
          <SectionDivider
            label="active sessions"
            detail={activeSessions.length > 0 ? `${activeSessions.length}` : undefined}
          />

          {activeSessions.length === 0 ? (
            <div className="py-8 text-center">
              <span className="font-mono text-[11px] text-text-ghost">
                No active PR sessions
              </span>
            </div>
          ) : (
            <div className="mt-3 space-y-0.5 stagger">
              {activeSessions.map((session) => (
                <PrSessionRow
                  key={session.id}
                  session={session}
                  onTaskClick={session.originTaskId
                    ? () => navigate(`/tasks/${session.originTaskId}`)
                    : undefined
                  }
                />
              ))}
            </div>
          )}

          {/* ── Created PRs ── */}
          <SectionDivider
            label="pull requests"
            detail={(prs ?? []).length > 0 ? `${(prs ?? []).length}` : undefined}
            className="mt-8"
          />

          {(prs ?? []).length === 0 ? (
            <div className="py-8 text-center">
              <span className="font-mono text-[11px] text-text-ghost">
                No pull requests yet
              </span>
            </div>
          ) : (
            <div className="mt-3 space-y-0.5 stagger">
              {(prs ?? []).map((pr) => (
                <PRRow
                  key={pr.taskId}
                  pr={pr}
                  onTaskClick={() => navigate(`/tasks/${pr.taskId}`)}
                  onDismiss={refetchAll}
                />
              ))}
            </div>
          )}

          {/* ── Closed Sessions ── */}
          {closedSessions.length > 0 && (
            <>
              <SectionDivider
                label="closed sessions"
                detail={`${closedSessions.length}`}
                className="mt-8"
              />
              <div className="mt-3 space-y-0.5 stagger">
                {closedSessions.map((session) => (
                  <PrSessionRow
                    key={session.id}
                    session={session}
                    onTaskClick={session.originTaskId
                      ? () => navigate(`/tasks/${session.originTaskId}`)
                      : undefined
                    }
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR Session Row
// ---------------------------------------------------------------------------

interface PrSessionRowProps {
  session: PrSession;
  onTaskClick?: () => void;
}

function PrSessionRow({ session, onTaskClick }: PrSessionRowProps) {
  const isExternal = !session.originTaskId;

  return (
    <div className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-glass animate-fade-up">
      {/* Mode indicator */}
      {isExternal ? (
        <Eye size={11} className="text-text-ghost shrink-0" title="External review" />
      ) : (
        <MessageSquare size={11} className="text-text-ghost shrink-0" title="Own PR" />
      )}

      {/* Repo */}
      <span className="font-mono text-[10px] text-accent/60">{session.repo}</span>

      {/* PR number */}
      {session.prNumber && (
        <span className="font-mono text-[11px] text-text-dim">
          #{session.prNumber}
        </span>
      )}

      {/* Origin task link */}
      {onTaskClick && session.originTaskId && (
        <button
          onClick={onTaskClick}
          className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
        >
          {shortId(session.originTaskId)}
          <ArrowUpRight size={9} />
        </button>
      )}

      {/* Branch */}
      {session.branch && (
        <span className="hidden sm:inline font-mono text-[9px] text-text-void truncate max-w-[200px]" title={session.branch}>
          {session.branch}
        </span>
      )}

      <span className="flex-1" />

      {/* Status */}
      <SessionStatusBadge status={session.status} />

      {/* Last polled */}
      {session.lastPolledAt && (
        <span className="font-mono text-[9px] text-text-void" title="Last polled">
          polled {timeAgo(session.lastPolledAt)}
        </span>
      )}

      {/* Created */}
      <span className="font-mono text-[10px] text-text-void">
        {timeAgo(session.createdAt)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session Status Badge
// ---------------------------------------------------------------------------

function SessionStatusBadge({ status }: { status: string }) {
  const isActive = status === "active";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide",
        isActive ? "text-accent" : "text-text-dim",
      )}
    >
      {isActive && (
        <span className="h-1 w-1 rounded-full bg-current animate-pulse-soft" />
      )}
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// PR Row (existing, from tasks)
// ---------------------------------------------------------------------------

function PRRow({
  pr,
  onTaskClick,
  onDismiss,
}: {
  pr: PR;
  onTaskClick: () => void;
  onDismiss: () => void;
}) {
  const [dismissing, setDismissing] = useState(false);
  const canDismiss = pr.status !== "running" && pr.status !== "queued";

  const handleDismiss = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDismiss || dismissing) return;
    setDismissing(true);
    try {
      await dismissTask(pr.taskId);
      onDismiss();
    } catch {
      setDismissing(false);
    }
  };

  return (
    <div className="group flex items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-glass animate-fade-up">
      <span className="font-mono text-[10px] text-accent/60">{pr.repo}</span>

      <button
        onClick={onTaskClick}
        className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
      >
        {shortId(pr.taskId)}
        <ArrowUpRight size={9} />
      </button>

      {pr.prNumber && (
        <span className="font-mono text-[11px] text-text-dim">
          #{pr.prNumber}
        </span>
      )}

      <span className="flex-1" />

      <StatusBadge status={pr.status} />

      {pr.prUrl && (
        <a
          href={pr.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
        >
          <ExternalLink size={10} />
          view
        </a>
      )}

      {canDismiss && (
        <button
          onClick={handleDismiss}
          disabled={dismissing}
          className="flex items-center gap-1 font-mono text-[10px] text-text-ghost hover:text-fail transition-colors disabled:opacity-40"
          title="Close PR and clean up"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
