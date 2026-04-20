/**
 * Subagent tool calls fan out to parallel workers. One row per worker, each
 * with live tool/token/duration stats and an expandable final-output panel.
 * The worker derivation lives in `lib/log-grouping.ts` (pure).
 */

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { formatMs, formatTime, formatTokens } from "@dashboard/lib/format";
import {
  deriveSubagentSummary,
  type SubagentWorker,
  type SubagentWorkerStatus,
  type ToolGroup as ToolGroupData,
} from "@dashboard/lib/log-grouping";
import { OutcomePill } from "./OutcomePill.js";

interface SubagentCardProps {
  group: ToolGroupData;
  collapsed: boolean;
  onToggle: () => void;
  compact: boolean;
}

export function SubagentCard({ group, collapsed, onToggle, compact }: SubagentCardProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const summary = useMemo(() => deriveSubagentSummary(group), [group]);
  const header = buildHeader(summary, group.done);

  return (
    <div className="py-0.5">
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors hover:bg-glass",
          group.done && summary.failedCount > 0 && "bg-fail-dim/20",
          !group.done && "bg-accent-dim/10",
        )}
      >
        {!compact && (
          <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px]">
            {formatTime(group.entries[0]?.ts ?? "")}
          </span>
        )}

        <Terminal size={11} className="shrink-0 text-accent" />
        <span className="shrink-0 text-text-dim font-medium text-[11px]">subagent</span>
        <span className="shrink-0 text-text-ghost text-[10px]">
          {summary.mode} ({summary.taskCount})
        </span>
        <span className="flex-1 truncate text-text-ghost text-[10px]">{header}</span>

        <span className="shrink-0 flex items-center gap-2">
          {group.durationMs !== undefined && (
            <span className="text-text-void text-[10px] tabular-nums">{formatMs(group.durationMs)}</span>
          )}
          {summary.totalCost > 0 && (
            <span className="text-text-void text-[10px] tabular-nums">${summary.totalCost.toFixed(4)}</span>
          )}
          <OutcomePill done={group.done} ok={group.ok} />
          <Chevron size={10} className="text-text-void" />
        </span>
      </button>

      {!collapsed && (
        <div className="ml-[76px] pl-3 py-1 border-l border-glass-border space-y-1">
          {summary.workers.map((w) => (
            <WorkerRow key={w.index} worker={w} />
          ))}
        </div>
      )}
    </div>
  );
}

// --- Helpers ---

const STATUS_TONE: Record<SubagentWorkerStatus, { label: string; color: string }> = {
  pending:   { label: "pending", color: "text-text-void" },
  running:   { label: "running", color: "text-accent/80" },
  completed: { label: "done",    color: "text-ok/70" },
  failed:    { label: "failed",  color: "text-fail/70" },
};

function buildHeader(s: { completedCount: number; failedCount: number; runningCount: number; taskCount: number }, done: boolean): string {
  const failed = s.failedCount > 0 ? ` \u00b7 ${s.failedCount} failed` : "";
  if (done) return `${s.completedCount}/${s.taskCount} ok${failed}`;
  return `${s.runningCount} running \u00b7 ${s.completedCount} done${failed}`;
}

function statsLine(w: SubagentWorker): string {
  if (w.status === "failed") return w.error ?? "failed";
  if (w.status === "pending") return "waiting";
  const tool = w.status === "running" && w.currentTool ? `${w.currentTool} \u00b7 ` : "";
  const dur = w.durationMs > 0 ? ` \u00b7 ${formatMs(w.durationMs)}` : "";
  return `${tool}${w.toolCount} tools \u00b7 ${formatTokens(w.tokens)} tok${dur}`;
}

interface WorkerRowProps {
  worker: SubagentWorker;
}

function WorkerRow({ worker }: WorkerRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = !!worker.finalOutput;
  const tone = STATUS_TONE[worker.status];

  return (
    <div className="py-0.5">
      <button
        onClick={() => hasOutput && setExpanded((v) => !v)}
        disabled={!hasOutput}
        className={cn(
          "flex w-full items-start gap-2 text-left rounded px-1 -mx-1 py-0.5",
          hasOutput && "hover:bg-glass cursor-pointer",
        )}
      >
        <span className={cn("shrink-0 text-[9px] font-medium px-1 py-px rounded tabular-nums", tone.color)}>
          {tone.label}
        </span>
        <span className="shrink-0 text-text-void text-[10px] tabular-nums w-5">#{worker.index + 1}</span>
        <span className="flex-1 text-text-ghost text-[10px] truncate">{worker.task}</span>
        <span className="shrink-0 text-text-void text-[10px]">{statsLine(worker)}</span>
      </button>

      {expanded && hasOutput && (
        <div className="ml-4 mt-1 py-1 px-2 bg-bg rounded text-[10px] text-text-secondary whitespace-pre-wrap break-words">
          {worker.finalOutput}
        </div>
      )}
    </div>
  );
}
