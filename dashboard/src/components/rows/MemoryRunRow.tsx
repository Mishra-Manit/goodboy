/** Collapsible row for one memory run, with transcript preview when available. */

import { useState } from "react";
import { LogViewer } from "@dashboard/components/log-viewer";
import { EmptyState } from "@dashboard/components/EmptyState";
import { StatusBadge } from "@dashboard/components/StatusBadge";
import { useQuery } from "@dashboard/hooks/use-query";
import { useNow } from "@dashboard/hooks/use-now";
import { fetchMemoryRunSession, type MemoryRun } from "@dashboard/lib/api";
import { formatDuration, timeAgo } from "@dashboard/lib/format";
import { cn, shortId } from "@dashboard/lib/utils";

interface MemoryRunRowProps {
  run: MemoryRun;
}

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

export function MemoryRunRow({ run }: MemoryRunRowProps) {
  const [expanded, setExpanded] = useState(false);
  const now = useNow();
  const isTest = run.instance.startsWith("TEST-");
  const duration = run.completedAt ? formatDuration(run.startedAt, run.completedAt) : null;
  const subtitle = run.externalLabel ?? (run.originTaskId ? `task ${shortId(run.originTaskId)}` : null);
  const transcript = useQuery(
    () => expanded && run.sessionPath ? fetchMemoryRunSession(run.id) : Promise.resolve({ entries: [] }),
    [expanded, run.id, run.sessionPath],
  );

  return (
    <div className="rounded-lg border border-glass-border bg-glass transition-all">
      <button
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full flex-wrap items-center gap-2 rounded-lg px-4 py-3 text-left transition-colors hover:bg-glass-hover"
      >
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
        <span className="font-mono text-[10px] text-text-void">{run.instance}</span>
        {run.sha && <span className="font-mono text-[10px] text-text-dim">{run.sha.slice(0, 8)}</span>}
        {run.zoneCount !== null && (
          <span className="font-mono text-[10px] text-text-ghost">
            {run.zoneCount} zone{run.zoneCount === 1 ? "" : "s"}
          </span>
        )}
        {subtitle && <span className="font-mono text-[10px] text-text-ghost">{subtitle}</span>}
        {run.error && (
          <span className="max-w-full truncate font-mono text-[10px] text-fail">
            {run.error}
          </span>
        )}
        <span className="flex-1" />
        {duration && <span className="font-mono text-[10px] text-text-void">{duration}</span>}
        <span className="font-mono text-[10px] text-text-ghost">{timeAgo(run.startedAt, now)}</span>
      </button>

      {expanded && (
        <div className="animate-fade-up border-t border-glass-border px-4 py-4">
          {run.error && (
            <div className="mb-3 rounded-md bg-fail-dim px-3 py-2">
              <p className="whitespace-pre-wrap font-mono text-[11px] text-fail/80">{run.error}</p>
            </div>
          )}

          {run.sessionPath ? (
            transcript.loading && !transcript.data ? (
              <div className="rounded-lg bg-bg-raised p-4">
                <span className="font-mono text-xs text-text-void animate-pulse-soft">
                  loading transcript...
                </span>
              </div>
            ) : transcript.error && !transcript.data ? (
              <div className="rounded-lg bg-bg-raised p-4">
                <span className="font-mono text-xs text-fail">{transcript.error}</span>
              </div>
            ) : (
              <LogViewer entries={transcript.data?.entries ?? []} maxHeight="400px" autoScroll={run.status === "running"} />
            )
          ) : (
            <EmptyState
              title="No transcript for this run"
              description={emptyTranscriptDescription(run.kind)}
            />
          )}
        </div>
      )}
    </div>
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
