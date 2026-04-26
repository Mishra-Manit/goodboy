/** Pull-request + PR-session list. */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchPRs, fetchPrSessions, setPrSessionWatchStatus, type PrSession } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { PrSessionRow } from "@dashboard/components/rows/PrSessionRow";
import { PrRow } from "@dashboard/components/rows/PrRow";

export function PullRequests() {
  const navigate = useNavigate();
  const { data: prs, loading: prsLoading, refetch: refetchPrs } = useQuery(() => fetchPRs());
  const { data: sessions, loading: sessionsLoading, refetch: refetchSessions } = useQuery(() => fetchPrSessions());

  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  const [updatingSessionId, setUpdatingSessionId] = useState<string | null>(null);

  const refetchAll = () => {
    refetchPrs();
    refetchSessions();
  };

  useSSERefresh(
    refetchAll,
    (e) => e.type === "pr_update" || e.type === "task_update" || e.type === "pr_session_update",
  );

  useSSE((event) => {
    if (event.type !== "pr_session_update") return;
    setRunningSessions((prev) => {
      const next = new Set(prev);
      if (event.running) next.add(event.prSessionId);
      else next.delete(event.prSessionId);
      return next;
    });
  });

  const activeSessions = (sessions ?? []).filter((s) => s.status === "active");
  const closedSessions = (sessions ?? []).filter((s) => s.status === "closed");
  const allPrs = prs ?? [];
  const loading = prsLoading || sessionsLoading;

  async function handleToggleWatch(session: PrSession) {
    if (updatingSessionId) return;
    const nextStatus = session.watchStatus === "muted" ? "watching" : "muted";
    setUpdatingSessionId(session.id);
    try {
      await setPrSessionWatchStatus(session.id, nextStatus);
      refetchSessions();
    } finally {
      setUpdatingSessionId(null);
    }
  }

  return (
    <div>
      <header className="mb-8">
        <h1 className="font-display text-lg font-semibold tracking-tight text-text">PR Sessions</h1>
        <p className="mt-1 font-mono text-[11px] text-text-ghost">
          PRs created by goodboy and active follow-up review sessions
        </p>
      </header>

      {loading && !prs && !sessions ? (
        <div className="py-12 text-center">
          <span className="font-mono text-xs text-text-ghost animate-pulse-soft">loading...</span>
        </div>
      ) : (
        <>
          <Section label="active sessions" count={activeSessions.length} emptyLabel="No active PR sessions">
            {activeSessions.map((session) => (
              <PrSessionRow
                key={session.id}
                session={session}
                running={runningSessions.has(session.id)}
                updatingWatch={updatingSessionId === session.id}
                onClick={() => navigate(`/prs/${session.id}`)}
                onToggleWatch={handleToggleWatch}
                onTaskClick={
                  session.originTaskId ? () => navigate(`/tasks/${session.originTaskId}`) : undefined
                }
              />
            ))}
          </Section>

          <Section
            label="pull requests"
            count={allPrs.length}
            emptyLabel="No pull requests yet"
            className="mt-8"
          >
            {allPrs.map((pr) => (
              <PrRow
                key={pr.taskId}
                pr={pr}
                onTaskClick={() => navigate(`/tasks/${pr.taskId}`)}
                onDismiss={refetchAll}
              />
            ))}
          </Section>

          {closedSessions.length > 0 && (
            <Section label="closed sessions" count={closedSessions.length} className="mt-8">
              {closedSessions.map((session) => (
                <PrSessionRow
                  key={session.id}
                  session={session}
                  running={false}
                  updatingWatch={false}
                  onClick={() => navigate(`/prs/${session.id}`)}
                  onToggleWatch={handleToggleWatch}
                  onTaskClick={
                    session.originTaskId ? () => navigate(`/tasks/${session.originTaskId}`) : undefined
                  }
                />
              ))}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

// --- Helpers ---

interface SectionProps {
  label: string;
  count: number;
  emptyLabel?: string;
  className?: string;
  children: React.ReactNode;
}

function Section({ label, count, emptyLabel, className, children }: SectionProps) {
  return (
    <>
      <SectionDivider label={label} detail={count > 0 ? `${count}` : undefined} className={className} />
      {count === 0 && emptyLabel ? (
        <div className="py-8 text-center">
          <span className="font-mono text-[11px] text-text-ghost">{emptyLabel}</span>
        </div>
      ) : (
        <div className="mt-3 space-y-0.5 stagger">{children}</div>
      )}
    </>
  );
}
