/** Renders a correlated tool_start..tool_end group as a collapsible row. */

import { useMemo } from "react";
import { ChevronRight, ChevronDown, Terminal } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { formatTime, formatMs } from "@dashboard/lib/format";
import { extractToolOutput, formatToolSummary, type ToolGroup as ToolGroupData } from "@dashboard/lib/log-grouping";
import { TOOL_ICON } from "./constants.js";
import { ToolOutput } from "./ToolOutput.js";
import { SubagentCard } from "./SubagentCard.js";
import { OutcomePill } from "./OutcomePill.js";

interface ToolGroupProps {
  group: ToolGroupData;
  collapsed: boolean;
  onToggle: () => void;
  compact: boolean;
}

export function ToolGroup({ group, collapsed, onToggle, compact }: ToolGroupProps) {
  if (group.toolName === "subagent") {
    return <SubagentCard group={group} collapsed={collapsed} onToggle={onToggle} compact={compact} />;
  }

  const Icon = TOOL_ICON[group.toolName] ?? Terminal;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const outputText = useMemo(() => extractToolOutput(group.entries), [group.entries]);
  const displaySummary = useMemo(
    () => formatToolSummary(group.toolName, group.summary),
    [group.toolName, group.summary],
  );

  return (
    <div className="py-0.5">
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors",
          "hover:bg-glass",
          !group.ok && "bg-fail-dim/20",
        )}
      >
        {!compact && (
          <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px]">
            {formatTime(group.entries[0]?.ts ?? "")}
          </span>
        )}

        <Icon size={11} className="shrink-0 text-text-void" />
        <span className="shrink-0 text-text-dim font-medium text-[11px]">{group.toolName}</span>
        <span className="flex-1 truncate text-text-ghost text-[10px]">{displaySummary}</span>

        <span className="shrink-0 flex items-center gap-2">
          {group.durationMs !== undefined && (
            <span className="text-text-void text-[10px] tabular-nums">{formatMs(group.durationMs)}</span>
          )}
          <OutcomePill done={group.done} ok={group.ok} />
          <Chevron size={10} className="text-text-void" />
        </span>
      </button>

      {!collapsed && <ToolOutput text={outputText} ok={group.ok} />}
    </div>
  );
}
