/** One non-tool line in the log stream (agent prose, stage info, stderr, error). */

import { cn } from "@dashboard/lib/utils";
import { formatTime } from "@dashboard/lib/format";
import { isRawToolJson } from "@dashboard/lib/log-grouping";
import type { LogEntry } from "@dashboard/lib/api";
import { KIND_COLOR } from "./constants.js";

interface LogLineProps {
  entry: LogEntry;
  compact: boolean;
}

export function LogLine({ entry, compact }: LogLineProps) {
  // Skip entries that belong inside a tool group (rendered by <ToolGroup>).
  if (entry.kind === "tool_output" || entry.kind === "tool_end" || entry.kind === "tool_update") {
    return null;
  }
  if (entry.kind === "text" && isRawToolJson(entry.text)) return null;

  const isStage = entry.kind === "stage_info";
  const isError = entry.kind === "error" || entry.kind === "stderr";

  return (
    <div
      className={cn(
        "flex items-start gap-2 py-px",
        isStage && "py-1.5 mt-1",
        isError && "bg-fail-dim/30 rounded px-1 -mx-1",
      )}
    >
      {!compact && (
        <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px] mt-px">
          {formatTime(entry.ts)}
        </span>
      )}
      {isStage ? (
        <span className="text-accent font-medium text-[10px]">{entry.text}</span>
      ) : (
        <span className={cn("whitespace-pre-wrap break-all", KIND_COLOR[entry.kind])}>
          {entry.text}
        </span>
      )}
    </div>
  );
}
