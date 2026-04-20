/**
 * Inline `!!` bash commands. pi records these as standalone
 * `BashExecutionMessage` entries, distinct from tool-call bash invocations.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight, Terminal } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import type { BashExecutionMessage } from "@dashboard/lib/api";
import { OutcomePill } from "./OutcomePill.js";

interface BashExecutionCardProps {
  message: BashExecutionMessage;
}

export function BashExecutionCard({ message }: BashExecutionCardProps) {
  const [collapsed, setCollapsed] = useState(true);
  const ok = message.exitCode === 0;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div className="py-0.5">
      <button
        onClick={() => setCollapsed((v) => !v)}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors hover:bg-glass",
          !ok && "bg-fail-dim/20",
        )}
      >
        <Terminal size={11} className="shrink-0 text-text-void" />
        <span className="shrink-0 text-text-dim font-medium text-[11px]">bash (!!)</span>
        <span className="flex-1 truncate text-text-ghost text-[10px]">{message.command}</span>
        <OutcomePill done ok={ok} />
        <Chevron size={10} className="text-text-void shrink-0" />
      </button>
      {!collapsed && (
        <div className={cn(
          "ml-4 border-l pl-3 py-1 text-[10px]",
          ok ? "border-glass-border" : "border-fail/30",
        )}>
          <pre className="whitespace-pre-wrap break-all text-text-void">{message.output || "(no output)"}</pre>
        </div>
      )}
    </div>
  );
}
