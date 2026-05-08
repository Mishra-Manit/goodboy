/**
 * Subagent tool calls fan out to parallel workers. We display one header row
 * plus one row per worker with final status/tokens/duration and an
 * expandable output panel.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { formatMs, formatTokens } from "@dashboard/lib/format";
import type { ToolCall, ToolResultMessage } from "@dashboard/lib/api";
import { OutcomePill } from "./OutcomePill.js";
import {
  detectSubagentMode,
  extractPlannedTasks,
  extractWorkers,
  summarizeWorkers,
  toPendingWorker,
  type SubagentWorker,
} from "./helpers.js";

interface SubagentCardProps {
  call: ToolCall;
  result?: ToolResultMessage;
}

export function SubagentCard({ call, result }: SubagentCardProps) {
  const [collapsed, setCollapsed] = useState(true);
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  const mode = detectSubagentMode(call);
  const plannedTasks = extractPlannedTasks(call);
  const workers = result ? extractWorkers(result, plannedTasks) : plannedTasks.map(toPendingWorker);
  const summary = summarizeWorkers(workers, result !== undefined);
  const done = result !== undefined;
  const ok = done && !result!.isError && workers.every((w) => w.ok !== false);

  return (
    <div className="py-0.5">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors hover:bg-glass",
          done && !ok && "bg-fail-dim/20",
          !done && "bg-accent-dim/10",
        )}
      >
        <Terminal size={11} className="shrink-0 text-accent" />
        <span className="shrink-0 text-text-dim font-medium text-[11px]">subagent</span>
        <span className="shrink-0 text-text-ghost text-[10px]">
          {mode} ({workers.length})
        </span>
        <span className="flex-1 truncate text-text-ghost text-[10px]">{summary}</span>
        <OutcomePill done={done} ok={ok} />
        <Chevron size={10} className="text-text-void shrink-0" />
      </button>

      {!collapsed && (
        <div className="ml-4 pl-3 py-1 border-l border-glass-border space-y-1">
          {workers.length === 0
            ? <div className="text-text-void italic text-[10px]">no workers</div>
            : workers.map((w, i) => <WorkerRow key={i} worker={w} index={i} />)}
        </div>
      )}
    </div>
  );
}

// --- Row ---

interface WorkerRowProps {
  worker: SubagentWorker;
  index: number;
}

function WorkerRow({ worker, index }: WorkerRowProps) {
  const [expanded, setExpanded] = useState(false);
  const status = worker.ok === undefined ? "pending" : worker.ok ? "done" : "failed";
  const tone =
    status === "done" ? "text-ok/70"
    : status === "failed" ? "text-fail/70"
    : "text-text-void";
  const hasOutput = worker.finalOutput.length > 0 || !!worker.error;

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
        <span className={cn("shrink-0 text-[9px] font-medium px-1 tabular-nums", tone)}>
          {status}
        </span>
        <span className="shrink-0 text-text-void text-[10px] tabular-nums w-5">#{index + 1}</span>
        <span className="shrink-0 text-text-dim text-[10px]">{worker.agent}</span>
        <span className="flex-1 text-text-ghost text-[10px] truncate">{worker.task}</span>
        <span className="shrink-0 text-text-void text-[10px] tabular-nums">
          {formatTokens(worker.tokens)} tok
          {worker.durationMs > 0 && ` · ${formatMs(worker.durationMs)}`}
        </span>
      </button>
      {expanded && hasOutput && (
        <div className="ml-4 mt-1 py-1 px-2 bg-bg rounded text-[10px] text-text-secondary whitespace-pre-wrap break-words">
          {worker.error ? `Error: ${worker.error}` : worker.finalOutput}
        </div>
      )}
    </div>
  );
}
