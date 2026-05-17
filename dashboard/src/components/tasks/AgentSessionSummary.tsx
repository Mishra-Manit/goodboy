/** Compact parent-agent and subagent execution metrics for a task. */

import type { AgentSessionDto } from "@dashboard/lib/api";
import { cn } from "@dashboard/lib/utils";

interface AgentSessionSummaryProps {
  sessions: readonly AgentSessionDto[];
}

/** Render persisted session metrics without replacing raw transcript views. */
export function AgentSessionSummary({ sessions }: AgentSessionSummaryProps) {
  if (sessions.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {sessions.map((session) => (
        <div key={session.id} className="rounded-lg border border-border-subtle bg-bg-raised/60 p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-text-ghost">
            <span className="text-text">{session.agentName}</span>
            <span>{session.model ?? "model unknown"}</span>
            <Metric label="duration" value={formatDuration(session.durationMs)} />
            <Metric label="tokens" value={formatNumber(session.totalTokens)} />
            <Metric label="cost" value={session.costUsd ? `$${session.costUsd}` : null} />
            <Metric label="tools" value={formatNumber(session.toolCallCount)} />
          </div>
          {session.subagents.length > 0 && (
            <div className="mt-2 space-y-1 border-t border-border-subtle pt-2">
              {session.subagents.map((run) => (
                <details key={run.id} className="group rounded-md bg-bg/50 px-2 py-1">
                  <summary className="cursor-pointer font-mono text-[10px] text-text-ghost marker:text-text-void">
                    <span className={cn(run.status === "failed" ? "text-fail" : "text-accent")}>{run.status}</span>
                    <span className="ml-2 text-text-dim">{run.agentName}</span>
                    {run.runIndex !== null && <span className="ml-2">#{run.runIndex + 1}</span>}
                  </summary>
                  <div className="mt-2 space-y-2 font-mono text-[10px] text-text-ghost">
                    <pre className="whitespace-pre-wrap rounded bg-bg-raised p-2">{run.prompt}</pre>
                    {run.resultText && <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-bg-raised p-2">{run.resultText}</pre>}
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string | null }) {
  return <span>{label}: {value ?? "n/a"}</span>;
}

function formatNumber(value: number | null): string | null {
  return value === null ? null : value.toLocaleString();
}

function formatDuration(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 1000)}s`;
}
