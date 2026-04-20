/** PR-session detail: header + one expandable run card per run. */

import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { fetchPrSessionDetail, fetchPrSessionLogs, type LogEntry } from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useLiveLogs } from "@dashboard/hooks/use-live-logs";
import { useNow } from "@dashboard/hooks/use-now";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { SessionHeader } from "@dashboard/components/SessionHeader";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { RunCard } from "@dashboard/components/rows/RunCard";
import { mergeLogEntries } from "@dashboard/lib/logs";

export function PrSessionDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/prs" replace />;
  const sessionId = id;

  const navigate = useNavigate();
  const now = useNow();
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const { data: session, loading, error, refetch } = useQuery(
    () => fetchPrSessionDetail(sessionId),
    [sessionId],
  );
  const { data: logsData } = useQuery(() => fetchPrSessionLogs(sessionId), [sessionId]);

  useSSERefresh(refetch, (e) => e.type === "pr_session_update" && e.prSessionId === sessionId);

  const liveLogs = useLiveLogs({
    match: (event) =>
      event.type === "pr_session_log" && event.prSessionId === sessionId
        ? { key: sessionId, entry: event.entry }
        : null,
  });

  const allLogs = useMemo(
    () => mergeLogEntries(logsData?.entries ?? [], liveLogs.get(sessionId) ?? []),
    [logsData, liveLogs, sessionId],
  );
  const logsForRun = (runId: string): LogEntry[] => allLogs.filter((e) => e.meta?.runId === runId);

  return (
    <div className="animate-fade-in">
      <BackLink label="back to PRs" onClick={() => navigate("/prs")} />

      <PageState data={session} loading={loading} error={error} onRetry={refetch} loadingLabel="loading session...">
        {(session) => (
          <>
            <SessionHeader
              session={session}
              running={session.runs.some((r) => r.status === "running")}
              now={now}
              onOriginTaskClick={(taskId) => navigate(`/tasks/${taskId}`)}
            />

            <SectionDivider label="runs" detail={`${session.runs.length}`} />

            {session.runs.length === 0 ? (
              <p className="py-8 text-center font-mono text-[11px] text-text-ghost">No runs yet</p>
            ) : (
              <div className="mt-3 space-y-3 stagger">
                {session.runs.map((run) => (
                  <RunCard
                    key={run.id}
                    run={run}
                    expanded={expandedRun === run.id}
                    onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
                    logs={logsForRun(run.id)}
                    isLive={run.status === "running"}
                    now={now}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </PageState>
    </div>
  );
}
