import { useState } from "react";
import { ExternalLink, ArrowUpRight, X, Eye, MessageSquare } from "lucide-react";
import {
  fetchPRs,
  fetchPrSessions,
  fetchPrSessionLogs,
  dismissTask,
  type PR,
  type PrSession,
  type LogEntry,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { LogViewer } from "@dashboard/components/LogViewer";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { shortId, timeAgo, cn } from "@dashboard/lib/utils";
import { useNavigate } from "react-router-dom";

export function PullRequests() {
  const navigate = useNavigate();
  const { data: prs, loading: prsLoading, refetch: refetchPrs } = useQuery(() => fetchPRs());
  const { data: sessions, loading: sessionsLoading, refetch: refetchSessions } = useQuery(() => fetchPrSessions());

  // Track which session is expanded + its logs
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [sessionLogs, setSessionLogs] = useState<Map<string, LogEntry[]>>(new Map());

  // Track which sessions are currently running (pi process active)
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());

  const refetchAll = () => { refetchPrs(); refetchSessions(); };

  useSSERefresh(refetchAll, (e) =>
    e.type === "pr_update" || e.type === "task_update" || e.type === "pr_session_update"
  );

  // Collect live log entries from SSE
  useSSE((event) => {
    if (event.type === "pr_session_log") {
      const prSessionId = event.prSessionId as string;
      const entry = event.entry as LogEntry;
      if (entry) {
        setSessionLogs((prev) => {
          const next = new Map(prev);
          const existing = next.get(prSessionId) ?? [];
          next.set(prSessionId, [...existing, entry]);
          return next;
        });
      }
    }
    if (event.type === "pr_session_update") {
      const prSessionId = event.prSessionId as string;
      const running = event.running as boolean;
      setRunningSessions((prev) => {
        const next = new Set(prev);
        if (running) next.add(prSessionId);
        else next.delete(prSessionId);
        return next;
      });
    }
  });

  async function toggleSession(sessionId: string) {
    if (expandedSession === sessionId) {
      setExpandedSession(null);
      return;
    }
    setExpandedSession(sessionId);
    // Load historical logs if we don't have any yet
    if (!sessionLogs.has(sessionId)) {
      try {
        const { entries } = await fetchPrSessionLogs(sessionId);
        setSessionLogs((prev) => {
          const next = new Map(prev);
          // Only set if we haven't received live entries in the meantime
          if (!next.has(sessionId) || next.get(sessionId)!.length === 0) {
            next.set(sessionId, entries);
          }
          return next;
        });
      } catch {
        // Logs may not exist yet
      }
    }
  }

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
          {/* -- Active PR Sessions -- */}
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
                <div key={session.id}>
                  <PrSessionRow
                    session={session}
                    running={runningSessions.has(session.id)}
                    expanded={expandedSession === session.id}
                    onClick={() => toggleSession(session.id)}
                    onTaskClick={session.originTaskId
                      ? () => navigate(`/tasks/${session.originTaskId}`)
                      : undefined
                    }
                  />
                  {expandedSession === session.id && (
                    <div className="mt-2 mb-3 animate-fade-up">
                      <LogViewer
                        entries={sessionLogs.get(session.id) ?? []}
                        maxHeight="350px"
                        autoScroll={runningSessions.has(session.id)}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* -- Created PRs -- */}
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

          {/* -- Closed Sessions -- */}
          {closedSessions.length > 0 && (
            <>
              <SectionDivider
                label="closed sessions"
                detail={`${closedSessions.length}`}
                className="mt-8"
              />
              <div className="mt-3 space-y-0.5 stagger">
                {closedSessions.map((session) => (
                  <div key={session.id}>
                    <PrSessionRow
                      session={session}
                      running={false}
                      expanded={expandedSession === session.id}
                      onClick={() => toggleSession(session.id)}
                      onTaskClick={session.originTaskId
                        ? () => navigate(`/tasks/${session.originTaskId}`)
                        : undefined
                      }
                    />
                    {expandedSession === session.id && (
                      <div className="mt-2 mb-3 animate-fade-up">
                        <LogViewer
                          entries={sessionLogs.get(session.id) ?? []}
                          maxHeight="350px"
                          autoScroll={false}
                        />
                      </div>
                    )}
                  </div>
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
  running: boolean;
  expanded: boolean;
  onClick: () => void;
  onTaskClick?: () => void;
}

function PrSessionRow({ session, running, expanded, onClick, onTaskClick }: PrSessionRowProps) {
  const isExternal = !session.originTaskId;

  return (
    <button
      onClick={onClick}
      className={cn(
        "group flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-glass animate-fade-up",
        expanded && "bg-glass",
      )}
    >
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
        <span
          onClick={(e) => { e.stopPropagation(); onTaskClick(); }}
          className="flex items-center gap-0.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors cursor-pointer"
        >
          {shortId(session.originTaskId)}
          <ArrowUpRight size={9} />
        </span>
      )}

      {/* Branch */}
      {session.branch && (
        <span className="hidden sm:inline font-mono text-[9px] text-text-void truncate max-w-[200px]" title={session.branch}>
          {session.branch}
        </span>
      )}

      <span className="flex-1" />

      {/* Running / status indicator */}
      {running ? (
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-accent">
          <span className="h-1 w-1 rounded-full bg-current animate-pulse-soft" />
          running
        </span>
      ) : (
        <span className={cn(
          "font-mono text-[10px] tracking-wide",
          session.status === "active" ? "text-text-dim" : "text-text-void",
        )}>
          {session.status === "active" ? "watching" : "closed"}
        </span>
      )}

      {/* Last polled */}
      {session.lastPolledAt && !running && (
        <span className="font-mono text-[9px] text-text-void" title="Last polled">
          polled {timeAgo(session.lastPolledAt)}
        </span>
      )}

      {/* Created */}
      <span className="font-mono text-[10px] text-text-void">
        {timeAgo(session.createdAt)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// PR Row (from tasks)
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
