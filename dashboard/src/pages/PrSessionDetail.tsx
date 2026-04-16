import { useState, useMemo } from "react";
import { useParams, useNavigate, Navigate } from "react-router-dom";
import { ArrowLeft, ExternalLink, MessageSquare, Eye, ArrowUpRight } from "lucide-react";
import {
  fetchPrSessionDetail,
  fetchPrSessionLogs,
  type PrSessionWithRuns,
  type PrSessionRun,
  type LogEntry,
} from "@dashboard/lib/api";
import { useQuery } from "@dashboard/hooks/use-query";
import { useSSE, useSSERefresh } from "@dashboard/hooks/use-sse";
import { LogViewer } from "@dashboard/components/LogViewer";
import { SectionDivider } from "@dashboard/components/SectionDivider";
import { shortId, formatDate, timeAgo, cn } from "@dashboard/lib/utils";

const TRIGGER_LABELS: Record<string, string> = {
  pr_creation: "PR creation",
  comments: "Comment feedback",
  external_review: "External review",
};

export function PrSessionDetail() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/prs" replace />;
  const sessionId: string = id;

  const navigate = useNavigate();
  const [expandedRun, setExpandedRun] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogEntry[]>([]);

  const {
    data: session,
    loading,
    error,
    refetch,
  } = useQuery(() => fetchPrSessionDetail(sessionId), [sessionId]);

  const { data: logsData } = useQuery(
    () => fetchPrSessionLogs(sessionId),
    [sessionId],
  );

  useSSERefresh(refetch, (e) =>
    e.type === "pr_session_update" &&
    (e as { prSessionId?: string }).prSessionId === sessionId
  );

  useSSE((event) => {
    if (
      event.type === "pr_session_log" &&
      (event.prSessionId as string) === sessionId
    ) {
      const entry = event.entry as LogEntry;
      if (entry) {
        setLiveLogs((prev) => [...prev, entry]);
      }
    }
  });

  // Merge disk + live logs, deduplicate by seq
  const allLogs = useMemo(() => {
    const disk = logsData?.entries ?? [];
    const maxDiskSeq = disk.length > 0 ? disk[disk.length - 1].seq : -1;
    const newLive = liveLogs.filter((e) => e.seq > maxDiskSeq);
    return [...disk, ...newLive];
  }, [logsData, liveLogs]);

  // Group logs by runId from metadata
  function getLogsForRun(runId: string): LogEntry[] {
    return allLogs.filter((e) => e.meta?.runId === runId);
  }

  if (loading && !session) {
    return (
      <div className="py-24 text-center">
        <span className="font-mono text-xs text-text-ghost animate-pulse-soft">
          loading session...
        </span>
      </div>
    );
  }

  if (error && !session) {
    return (
      <div className="py-24 text-center">
        <span className="font-mono text-xs text-fail">{error}</span>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="py-24 text-center">
        <span className="font-mono text-xs text-text-ghost">session not found</span>
      </div>
    );
  }

  const isExternal = !session.originTaskId;
  const isActive = session.status === "active";
  const hasRunningRun = session.runs.some((r) => r.status === "running");

  return (
    <div className="animate-fade-in">
      {/* Back */}
      <button
        onClick={() => navigate("/prs")}
        className="mb-6 flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-text-dim transition-colors"
      >
        <ArrowLeft size={12} />
        back to PRs
      </button>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          {isExternal ? (
            <Eye size={13} className="text-text-ghost" />
          ) : (
            <MessageSquare size={13} className="text-text-ghost" />
          )}
          <span className="font-mono text-[11px] font-medium text-accent">
            {session.repo}
          </span>
          {session.prNumber && (
            <span className="font-mono text-[13px] text-text-dim">
              #{session.prNumber}
            </span>
          )}
          <SessionStatusBadge status={session.status} running={hasRunningRun} />
        </div>

        {/* Meta */}
        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[10px] text-text-void">
          <span>created {formatDate(session.createdAt)}</span>
          {session.branch && <span>branch: {session.branch}</span>}
          {session.originTaskId && (
            <button
              onClick={() => navigate(`/tasks/${session.originTaskId}`)}
              className="flex items-center gap-0.5 text-text-ghost hover:text-text-dim transition-colors"
            >
              task {shortId(session.originTaskId)}
              <ArrowUpRight size={9} />
            </button>
          )}
          {session.lastPolledAt && (
            <span>last polled {timeAgo(session.lastPolledAt)}</span>
          )}
        </div>

        {/* GitHub link */}
        {session.prNumber && (
          <div className="mt-2">
            <a
              href={`https://github.com/${session.repo}/pull/${session.prNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] text-text-ghost hover:text-accent transition-colors"
            >
              <ExternalLink size={10} />
              view on GitHub
            </a>
          </div>
        )}
      </div>

      {/* Runs */}
      <SectionDivider
        label="runs"
        detail={`${session.runs.length}`}
      />

      {session.runs.length === 0 ? (
        <div className="py-8 text-center">
          <span className="font-mono text-[11px] text-text-ghost">
            No runs yet
          </span>
        </div>
      ) : (
        <div className="mt-3 space-y-3 stagger">
          {session.runs.map((run) => (
            <RunCard
              key={run.id}
              run={run}
              expanded={expandedRun === run.id}
              onToggle={() => setExpandedRun(expandedRun === run.id ? null : run.id)}
              logs={getLogsForRun(run.id)}
              isLive={run.status === "running"}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Run Card
// ---------------------------------------------------------------------------

interface RunCardProps {
  run: PrSessionRun;
  expanded: boolean;
  onToggle: () => void;
  logs: LogEntry[];
  isLive: boolean;
}

function RunCard({ run, expanded, onToggle, logs, isLive }: RunCardProps) {
  const triggerLabel = TRIGGER_LABELS[run.trigger] ?? run.trigger;
  const duration = run.completedAt && run.startedAt
    ? formatDuration(run.startedAt, run.completedAt)
    : null;

  return (
    <div className={cn(
      "rounded-lg border transition-all",
      isLive
        ? "border-l-accent/30 border-l-2 border-glass-border bg-glass shadow-[inset_2px_0_12px_rgba(212,160,23,0.04)]"
        : "border-glass-border bg-glass",
    )}>
      {/* Run header */}
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-glass-hover transition-colors rounded-lg"
      >
        <span className="font-mono text-[11px] font-medium text-text">
          {triggerLabel}
        </span>

        <RunStatusBadge status={run.status} />

        {duration && (
          <span className="font-mono text-[10px] text-text-void tabular-nums">
            {duration}
          </span>
        )}

        <span className="flex-1" />

        <span className="font-mono text-[10px] text-text-void">
          {timeAgo(run.startedAt)}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 animate-fade-up">
          {/* Error */}
          {run.error && (
            <div className="mb-3 rounded-md bg-fail-dim px-3 py-2">
              <p className="font-mono text-[11px] text-fail/70 whitespace-pre-wrap">
                {run.error}
              </p>
            </div>
          )}

          {/* Comments that triggered this run */}
          {run.trigger === "comments" && run.comments && run.comments.length > 0 && (
            <div className="mb-3">
              <span className="font-mono text-[9px] uppercase tracking-wider text-text-ghost block mb-2">
                triggering comments
              </span>
              <div className="space-y-2">
                {run.comments.map((c, i) => (
                  <div key={i} className="rounded-md bg-bg-raised px-3 py-2">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono text-[10px] font-medium text-text-dim">
                        @{c.author}
                      </span>
                      {c.path && (
                        <span className="font-mono text-[9px] text-text-void">
                          {c.path}{c.line ? `:${c.line}` : ""}
                        </span>
                      )}
                    </div>
                    <p className="font-mono text-[11px] text-text-secondary whitespace-pre-wrap leading-relaxed">
                      {c.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Logs */}
          <LogViewer
            entries={logs}
            maxHeight="400px"
            autoScroll={isLive}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status badges
// ---------------------------------------------------------------------------

function SessionStatusBadge({ status, running }: { status: string; running: boolean }) {
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide text-accent">
        <span className="h-1 w-1 rounded-full bg-current animate-pulse-soft" />
        running
      </span>
    );
  }
  return (
    <span className={cn(
      "font-mono text-[10px] tracking-wide",
      status === "active" ? "text-ok" : "text-text-dim",
    )}>
      {status}
    </span>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; color: string; pulse?: boolean }> = {
    running: { label: "running", color: "text-accent", pulse: true },
    complete: { label: "complete", color: "text-ok" },
    failed: { label: "failed", color: "text-fail" },
  };
  const c = config[status] ?? { label: status, color: "text-text-dim" };

  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-[10px] tracking-wide", c.color)}>
      {c.pulse && <span className="h-1 w-1 rounded-full bg-current animate-pulse-soft" />}
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  return `${mins}m ${remainSecs}s`;
}
