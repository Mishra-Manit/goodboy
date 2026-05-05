/**
 * PR-session detail: header + one expandable run card per run. Runs are
 * delimited within the pi session transcript by `startedAt`/`completedAt`
 * timestamps, not by a per-entry tag.
 */

import { useMemo, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  fetchPrSessionDetail,
  fetchPrSessionTranscript,
  setPrSessionWatchStatus,
  type FileEntry,
  type PrSessionRun,
  type PrSessionWithRuns,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSERefresh } from "@dashboard/hooks/use-sse";
import { useLiveSession } from "@dashboard/hooks/use-live-session";
import { useNow } from "@dashboard/hooks/use-now";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { SessionHeader } from "@dashboard/components/SessionHeader";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { RunCard } from "@dashboard/components/rows/RunCard";
import { dedupeById } from "@dashboard/components/log-viewer/helpers";

export function PrSessionDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/prs" replace />;
  const sessionId = id;

  const navigate = useNavigate();
  const now = useNow();
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [updatingWatch, setUpdatingWatch] = useState(false);

  const { data: session, loading, error, refetch } = useQuery(
    `pr-session:${sessionId}`,
    () => fetchPrSessionDetail(sessionId),
  );
  const { data: transcript } = useQuery(
    `pr-session-transcript:${sessionId}`,
    () => fetchPrSessionTranscript(sessionId),
  );

  useSSERefresh(refetch, (e) => e.type === "pr_session_update" && e.prSessionId === sessionId);

  const liveEntries = useLiveSession({
    match: (event) =>
      event.type === "session_entry" && event.scope === "pr_session" && event.id === sessionId
        ? { key: sessionId, entry: event.entry }
        : null,
  });

  const allEntries = useMemo(
    () => dedupeById([...(transcript?.entries ?? []), ...(liveEntries.get(sessionId) ?? [])]),
    [transcript, liveEntries, sessionId],
  );

  const entriesForRun = (run: PrSessionRun): FileEntry[] =>
    allEntries.filter((e) => isEntryInRun(e, run));

  async function handleToggleWatch(session: PrSessionWithRuns) {
    if (updatingWatch) return;
    const nextStatus = session.watchStatus === "muted" ? "watching" : "muted";
    setUpdatingWatch(true);
    try {
      await setPrSessionWatchStatus(session.id, nextStatus);
      refetch();
    } finally {
      setUpdatingWatch(false);
    }
  }

  return (
    <div className="animate-fade-in">
      <BackLink label="back to PRs" onClick={() => navigate("/prs")} />

      <PageState data={session} loading={loading} error={error} onRetry={refetch} loadingLabel="loading session...">
        {(session) => (
          <>
            <SessionHeader
              session={session}
              running={session.runs.some((r) => r.status === "running")}
              updatingWatch={updatingWatch}
              now={now}
              onSourceTaskClick={(taskId) => navigate(`/tasks/${taskId}`)}
              onToggleWatch={handleToggleWatch}
            />

            {session.prNumber !== null && (
              <button
                type="button"
                onClick={() => navigate(`/prs/${session.id}/review`)}
                className="mb-5 font-mono text-[11px] text-accent transition-colors hover:underline"
              >
                view review →
              </button>
            )}

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
                    entries={entriesForRun(run)}
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

// --- Helpers ---

/**
 * A session entry belongs to a run if its timestamp falls inside the run's
 * time window. Entries with no timestamp (the session header) are excluded.
 */
function isEntryInRun(entry: FileEntry, run: PrSessionRun): boolean {
  const ts = "timestamp" in entry && typeof entry.timestamp === "string" ? entry.timestamp : null;
  if (!ts) return false;
  const t = new Date(ts).getTime();
  const startedAt = new Date(run.startedAt).getTime();
  const endedAt = run.completedAt ? new Date(run.completedAt).getTime() : Number.POSITIVE_INFINITY;
  return t >= startedAt && t <= endedAt;
}
