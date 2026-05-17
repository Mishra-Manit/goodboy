/** Compact parent-agent and subagent execution metrics for a task. */

import type { AgentSessionDto } from "@dashboard/lib/api";
import { cn } from "@dashboard/lib/utils";

interface AgentSessionSummaryProps {
  sessions: readonly AgentSessionDto[];
}

/** Render persisted session metrics without replacing raw transcript views. */
export function AgentSessionSummary({ sessions }: AgentSessionSummaryProps) {
  if (sessions.length === 0) return null;
  const cost = summarizeCost(sessions);

  return (
    <div className="mt-3 space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-border-subtle bg-glass p-4">
        <div className="absolute inset-x-0 top-0 h-px bg-accent/40" />
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-[0.24em] text-text-ghost">agent spend</p>
            <p className="mt-1 font-display text-2xl leading-none text-text">{formatCostValue(cost.total)}</p>
          </div>
          <div className="flex gap-2 font-mono text-[10px] text-text-ghost">
            <CostPill label="priced" value={`${cost.priced}/${cost.totalRows}`} tone="accent" />
            <CostPill label="unknown" value={String(cost.totalRows - cost.priced)} tone="muted" />
          </div>
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-bg-raised">
          <div className="h-full w-full origin-left animate-pulse-soft rounded-full bg-accent/70" />
        </div>
      </div>

      {sessions.map((session) => (
        <div key={session.id} className="rounded-lg border border-border-subtle bg-bg-raised/60 p-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-text-ghost">
            <span className="text-text">{session.agentName}</span>
            <span>{session.model ?? "model unknown"}</span>
            <Metric label="cost" value={formatCost(session.costUsd)} strong />
            <Metric label="duration" value={formatDuration(session.durationMs)} />
            <Metric label="tokens" value={formatNumber(session.totalTokens)} />
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
                    <span className="ml-2 text-accent/80">{formatCost(run.costUsd) ?? "cost n/a"}</span>
                  </summary>
                  <div className="mt-2 space-y-2 font-mono text-[10px] text-text-ghost">
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg-raised p-2">{run.prompt}</pre>
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

function CostPill({ label, value, tone }: { label: string; value: string; tone: "accent" | "muted" }) {
  return (
    <span className={cn(
      "rounded-full border px-2 py-1",
      tone === "accent" ? "border-accent/30 bg-accent/10 text-accent" : "border-border-subtle bg-bg-raised text-text-ghost",
    )}>
      {label}: {value}
    </span>
  );
}

function Metric({ label, value, strong = false }: { label: string; value: string | null; strong?: boolean }) {
  return <span className={cn(strong && value ? "text-accent" : undefined)}>{label}: {value ?? "n/a"}</span>;
}

function summarizeCost(sessions: readonly AgentSessionDto[]): { total: number; priced: number; totalRows: number } {
  const costs = sessions.flatMap((session) => [session.costUsd, ...session.subagents.map((run) => run.costUsd)]);
  const parsed = costs.map(parseCost);
  return {
    total: parsed.reduce((sum, value) => sum + (value ?? 0), 0),
    priced: parsed.filter((value) => value !== null).length,
    totalRows: costs.length,
  };
}

function parseCost(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatNumber(value: number | null): string | null {
  return value === null ? null : value.toLocaleString();
}

function formatCost(value: string | null): string | null {
  const parsed = parseCost(value);
  return parsed === null ? null : formatCostValue(parsed);
}

function formatCostValue(value: number): string {
  if (value === 0) return "$0.0000";
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function formatDuration(value: number | null): string | null {
  if (value === null) return null;
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 1000)}s`;
}
