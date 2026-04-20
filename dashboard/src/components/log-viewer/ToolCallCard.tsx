/**
 * One tool invocation: header row + optional collapsible result pane. The
 * subagent tool has a richer layout (per-worker rows) and is delegated to
 * `<SubagentCard>`.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal, FileText, Pencil } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import type { ToolCall, ToolResultMessage } from "@dashboard/lib/api";
import { joinText } from "./helpers.js";
import { OutcomePill } from "./OutcomePill.js";
import { SubagentCard } from "./SubagentCard.js";

const TOOL_ICON: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  edit: Pencil,
  write: Pencil,
};

const BASH_SUMMARY_CAP = 120;

interface ToolCallCardProps {
  call: ToolCall;
  result?: ToolResultMessage;
}

export function ToolCallCard({ call, result }: ToolCallCardProps) {
  if (call.name === "subagent") return <SubagentCard call={call} result={result} />;

  const [collapsed, setCollapsed] = useState(true);
  const Icon = TOOL_ICON[call.name] ?? Terminal;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const done = result !== undefined;
  const ok = !result?.isError;
  const summary = summarizeCall(call);
  const outputText = result ? joinText(result.content) : "";

  return (
    <div className="py-0.5">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors hover:bg-glass",
          done && !ok && "bg-fail-dim/20",
        )}
      >
        <Icon size={11} className="shrink-0 text-text-void" />
        <span className="shrink-0 text-text-dim font-medium text-[11px]">{call.name}</span>
        <span className="flex-1 truncate text-text-ghost text-[10px]">{summary}</span>
        <OutcomePill done={done} ok={ok} />
        <Chevron size={10} className="text-text-void shrink-0" />
      </button>

      {!collapsed && (
        <div className={cn(
          "ml-4 border-l pl-3 py-1 text-[10px]",
          ok ? "border-glass-border" : "border-fail/30",
        )}>
          {outputText
            ? <pre className="whitespace-pre-wrap break-all text-text-void">{outputText}</pre>
            : <span className="italic text-text-void">{done ? "(no output)" : "running..."}</span>}
        </div>
      )}
    </div>
  );
}

// --- Helpers ---

function summarizeCall(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === "bash") {
    const cmd = String(args.command ?? "");
    return cmd.length > BASH_SUMMARY_CAP ? `${cmd.slice(0, BASH_SUMMARY_CAP)}...` : cmd;
  }
  if (call.name === "read" || call.name === "edit" || call.name === "write") {
    return String(args.path ?? "");
  }
  return "";
}
