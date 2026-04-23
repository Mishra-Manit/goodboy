/** Memory run detail: header, error, live-streamed transcript. */

import { useMemo } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import {
  fetchMemoryRun,
  fetchMemoryRunSession,
  type MemoryRun,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useMemoryRunStream } from "@dashboard/hooks/use-memory-run-stream";
import { useNow } from "@dashboard/hooks/use-now";
import { BackLink } from "@dashboard/components/BackLink";
import { PageState } from "@dashboard/components/PageState";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { LogViewer } from "@dashboard/components/log-viewer";
import { dedupeById } from "@dashboard/components/log-viewer/helpers";
import { formatDuration, timeAgo } from "@dashboard/lib/format";
import { cn, shortId } from "@dashboard/lib/utils";

const KIND_TONE: Record<MemoryRun["kind"], string> = {
  cold: "text-accent",
  warm: "text-warn",
  skip: "text-text-void",
  noop: "text-text-dim",
};

const SOURCE_LABEL: Record<MemoryRun["source"], string> = {
  task: "task",
  manual_test: "manual test",
};

export function MemoryDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/memory" replace />;
  const runId = id;

  const navigate = useNavigate();
  const now = useNow();

  const { data: run, loading, error, refetch } = useQuery(() => fetchMemoryRun(runId), [runId]);
  const { data: sessionData, refetch: refetchSession } = useQuery(
    () => fetchMemoryRunSession(runId),
    [runId],
  );

  const liveEntries = useMemoryRunStream({
    runId,
    enabled: Boolean(run?.sessionPath),
    onRunUpdate: () => {
      refetch();
      refetchSession();
    },
  });

  const mergedEntries = useMemo(
    () => dedupeById([...(sessionData?.entries ?? []), ...liveEntries]),
    [sessionData, liveEntries],
  );

  return (
    <div className="animate-fade-in">
      <BackLink label="back" onClick={() => navigate(-1)} />
      <PageState data={run} loading={loading} error={error} onRetry={refetch} loadingLabel="loading memory run...">
        {(run) => (
          <>
            <MemoryRunHeader run={run} now={now} />

            {run.error && (
              <div className="mb-6 rounded-md bg-fail-dim px-4 py-3">
                <span className="font-mono text-[10px] text-fail/80 block mb-0.5">error</span>
                <p className="font-mono text-[11px] text-fail/70 whitespace-pre-wrap">{run.error}</p>
              </div>
            )}

            <SectionDivider label="transcript" />
            <div className="mt-3">
              {run.sessionPath ? (
                <LogViewer
                  entries={mergedEntries}
                  maxHeight="720px"
                  autoScroll={run.status === "running"}
                />
              ) : (
                <p className="py-4 font-mono text-[11px] text-text-void">
                  {emptyTranscriptDescription(run.kind)}
                </p>
              )}
            </div>
          </>
        )}
      </PageState>
    </div>
  );
}

// --- Header ---

interface MemoryRunHeaderProps {
  run: MemoryRun;
  now: number;
}

function MemoryRunHeader({ run, now }: MemoryRunHeaderProps) {
  const isTest = run.instance.startsWith("TEST-");
  const duration = run.completedAt ? formatDuration(run.startedAt, run.completedAt) : null;
  const subtitle = run.externalLabel ?? (run.originTaskId ? `task ${shortId(run.originTaskId)}` : null);

  return (
    <header className="mb-6">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={cn("font-mono text-[10px] uppercase tracking-wide", KIND_TONE[run.kind])}>
          {run.kind}
        </span>
        <StatusBadge status={run.status} />
        <span className="font-mono text-[10px] text-text-ghost">{SOURCE_LABEL[run.source]}</span>
        {isTest && (
          <span className="rounded-full border border-glass-border px-2 py-0.5 font-mono text-[9px] text-text-ghost">
            TEST
          </span>
        )}
      </div>
      <h1 className="font-display text-lg font-semibold tracking-tight text-text">{run.repo}</h1>
      <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-text-ghost">
        <span className="text-text-void">{run.instance}</span>
        {run.sha && <span className="text-text-dim">{run.sha.slice(0, 8)}</span>}
        {run.zoneCount !== null && (
          <span>{run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}</span>
        )}
        {subtitle && <span>{subtitle}</span>}
        {duration && <span className="text-text-void tabular-nums">{duration}</span>}
        <span>{timeAgo(run.startedAt, now)}</span>
      </div>
    </header>
  );
}

// --- Helpers ---

function emptyTranscriptDescription(kind: MemoryRun["kind"]): string {
  if (kind === "skip") {
    return "This run was skipped because another memory run already held the repo lock.";
  }
  if (kind === "noop") {
    return "This repo was already up to date, so memory finished without running a session.";
  }
  return "This run completed without a saved session transcript.";
}
