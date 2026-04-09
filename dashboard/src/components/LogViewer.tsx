import { useEffect, useRef, useState, useMemo } from "react";
import { cn } from "@dashboard/lib/utils";
import type { LogEntry, LogEntryKind } from "@dashboard/lib/api";
import { ChevronRight, ChevronDown } from "lucide-react";

/* ── Kind styling: minimal, monochrome with selective color ── */

const KIND_COLOR: Record<LogEntryKind, string> = {
  text: "text-text-secondary",
  tool_start: "text-text-secondary",
  tool_end: "text-text-secondary",
  tool_output: "text-text-ghost",
  stage_info: "text-accent",
  rpc: "text-text-void",
  error: "text-fail",
  stderr: "text-warn",
};

const KIND_PREFIX: Record<LogEntryKind, string> = {
  text: "$",
  tool_start: ">",
  tool_end: ">",
  tool_output: " ",
  stage_info: "#",
  rpc: "~",
  error: "!",
  stderr: "!",
};

interface LogViewerProps {
  entries: LogEntry[];
  className?: string;
  autoScroll?: boolean;
  maxHeight?: string;
  compact?: boolean;
}

export function LogViewer({
  entries,
  className,
  autoScroll = true,
  maxHeight = "400px",
  compact = false,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedTools, setCollapsedTools] = useState(new Set<number>());
  const [userScrolled, setUserScrolled] = useState(false);

  const processed = useMemo(() => groupToolCalls(entries), [entries]);

  useEffect(() => {
    if (autoScroll && !userScrolled && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, autoScroll, userScrolled]);

  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setUserScrolled(scrollHeight - scrollTop - clientHeight > 40);
  }

  function toggleTool(seq: number) {
    setCollapsedTools((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  if (entries.length === 0) {
    return (
      <div className={cn("rounded-lg bg-bg-raised p-4", className)}>
        <span className="font-mono text-xs text-text-void animate-pulse-soft">
          waiting for output...
        </span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg bg-bg-raised", className)}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="overflow-auto p-3 font-mono text-[11px] leading-[1.7]"
        style={{ maxHeight }}
      >
        {processed.map((item) =>
          item.type === "group" ? (
            <ToolGroup
              key={item.startSeq}
              group={item}
              collapsed={collapsedTools.has(item.startSeq)}
              onToggle={() => toggleTool(item.startSeq)}
              compact={compact}
            />
          ) : (
            <LogLine key={item.entry.seq} entry={item.entry} compact={compact} />
          )
        )}
      </div>

      {/* Scroll anchor */}
      {userScrolled && (
        <button
          onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop = containerRef.current.scrollHeight;
              setUserScrolled(false);
            }
          }}
          className="mx-auto mb-2 block font-mono text-[9px] text-text-ghost hover:text-text-dim transition-colors"
        >
          scroll to bottom
        </button>
      )}
    </div>
  );
}

function LogLine({ entry, compact }: { entry: LogEntry; compact: boolean }) {
  if (entry.kind === "tool_output" || entry.kind === "tool_end") return null;

  const prefix = KIND_PREFIX[entry.kind];

  return (
    <div className="flex items-start gap-2 py-px">
      {!compact && (
        <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px] mt-px">
          {formatTime(entry.ts)}
        </span>
      )}
      <span className="shrink-0 w-2 text-text-void text-[10px] mt-px">{prefix}</span>
      <span className={cn("whitespace-pre-wrap break-all", KIND_COLOR[entry.kind])}>
        {entry.text}
      </span>
    </div>
  );
}

/* ── Tool call groups ── */

interface ToolGroupData {
  type: "group";
  startSeq: number;
  toolName: string;
  summary: string;
  entries: LogEntry[];
  ok: boolean;
  durationMs?: number;
}

function ToolGroup({
  group,
  collapsed,
  onToggle,
  compact,
}: {
  group: ToolGroupData;
  collapsed: boolean;
  onToggle: () => void;
  compact: boolean;
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <div className="py-px">
      <button
        onClick={onToggle}
        className="flex w-full items-start gap-2 text-left hover:bg-glass rounded px-0 py-px transition-colors"
      >
        {!compact && (
          <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px] mt-px">
            {formatTime(group.entries[0]?.ts ?? "")}
          </span>
        )}
        <Chevron size={10} className="shrink-0 mt-[3px] text-text-void" />
        <span className="text-text-secondary">
          {group.toolName}
        </span>
        <span className="flex-1 truncate text-text-ghost">{group.summary}</span>
        <span className="shrink-0 flex items-center gap-2">
          {group.durationMs !== undefined && (
            <span className="text-text-void text-[10px]">
              {group.durationMs > 1000
                ? `${(group.durationMs / 1000).toFixed(1)}s`
                : `${group.durationMs}ms`}
            </span>
          )}
          <span className={group.ok ? "text-ok text-[10px]" : "text-fail text-[10px]"}>
            {group.ok ? "ok" : "err"}
          </span>
        </span>
      </button>

      {!collapsed && (
        <div className="ml-[76px] border-l border-glass-border pl-3 py-0.5">
          {group.entries
            .filter((e) => e.kind === "tool_output")
            .map((e) => (
              <div
                key={e.seq}
                className="text-text-void whitespace-pre-wrap break-all py-px text-[10px]"
              >
                {e.text}
              </div>
            ))}
          {group.entries.filter((e) => e.kind === "tool_output").length === 0 && (
            <span className="text-text-void text-[10px]">no output</span>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Grouping logic ── */

type ProcessedItem = { type: "line"; entry: LogEntry } | ToolGroupData;

function groupToolCalls(entries: LogEntry[]): ProcessedItem[] {
  const result: ProcessedItem[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind === "tool_start") {
      const toolName = (entry.meta?.tool as string) ?? "tool";
      const group: LogEntry[] = [entry];
      let ok = true;
      let durationMs: number | undefined;

      let j = i + 1;
      while (j < entries.length) {
        const next = entries[j];
        if (next.kind === "tool_output" && next.meta?.tool === toolName) {
          group.push(next);
          j++;
        } else if (next.kind === "tool_end" && next.meta?.tool === toolName) {
          group.push(next);
          ok = (next.meta?.ok as boolean) ?? true;
          durationMs = next.meta?.durationMs as number | undefined;
          j++;
          break;
        } else {
          break;
        }
      }

      result.push({
        type: "group",
        startSeq: entry.seq,
        toolName,
        summary: entry.text,
        entries: group,
        ok,
        durationMs,
      });
      i = j;
    } else {
      result.push({ type: "line", entry });
      i++;
    }
  }

  return result;
}

function formatTime(ts: string): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}
