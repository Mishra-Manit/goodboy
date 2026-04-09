import { useEffect, useRef, useState, useMemo } from "react";
import { cn } from "@dashboard/lib/utils";
import type { LogEntry, LogEntryKind } from "@dashboard/lib/api";
import {
  Terminal,
  Wrench,
  CheckCircle2,
  XCircle,
  Info,
  AlertTriangle,
  ChevronRight,
  ChevronDown,
  Search,
  Filter,
} from "lucide-react";

const KIND_CONFIG: Record<
  LogEntryKind,
  { color: string; icon: typeof Terminal; label: string; dimBg?: string }
> = {
  text: { color: "text-zinc-300", icon: Terminal, label: "Output" },
  tool_start: {
    color: "text-sky-400",
    icon: Wrench,
    label: "Tool",
    dimBg: "bg-sky-500/5",
  },
  tool_end: { color: "text-sky-400", icon: CheckCircle2, label: "Tool" },
  tool_output: { color: "text-zinc-500", icon: Terminal, label: "Result" },
  stage_info: {
    color: "text-violet-400",
    icon: Info,
    label: "Stage",
    dimBg: "bg-violet-500/5",
  },
  rpc: { color: "text-zinc-600", icon: Terminal, label: "RPC" },
  error: {
    color: "text-red-400",
    icon: XCircle,
    label: "Error",
    dimBg: "bg-red-500/5",
  },
  stderr: {
    color: "text-amber-400",
    icon: AlertTriangle,
    label: "Stderr",
    dimBg: "bg-amber-500/5",
  },
};

const FILTER_OPTIONS: { kind: LogEntryKind | "all"; label: string }[] = [
  { kind: "all", label: "All" },
  { kind: "text", label: "Output" },
  { kind: "tool_start", label: "Tools" },
  { kind: "error", label: "Errors" },
  { kind: "stage_info", label: "Stage" },
];

interface LogViewerProps {
  entries: LogEntry[];
  className?: string;
  autoScroll?: boolean;
  maxHeight?: string;
  /** Compact mode hides filters and timestamps */
  compact?: boolean;
}

export function LogViewer({
  entries,
  className,
  autoScroll = true,
  maxHeight = "500px",
  compact = false,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<LogEntryKind | "all">("all");
  const [collapsedTools, setCollapsedTools] = useState(new Set<number>());
  const [userScrolled, setUserScrolled] = useState(false);

  // Group tool_start -> tool_output -> tool_end into collapsible blocks
  const processedEntries = useMemo(() => {
    return groupToolCalls(entries);
  }, [entries]);

  const filtered = useMemo(() => {
    return processedEntries.filter((item) => {
      if (kindFilter !== "all") {
        if (item.type === "group") {
          if (kindFilter !== "tool_start") return false;
        } else if (item.entry.kind !== kindFilter) {
          return false;
        }
      }
      if (search) {
        const text =
          item.type === "group"
            ? item.entries.map((e) => e.text).join(" ")
            : item.entry.text;
        if (!text.toLowerCase().includes(search.toLowerCase())) return false;
      }
      return true;
    });
  }, [processedEntries, kindFilter, search]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && !userScrolled && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [entries, autoScroll, userScrolled]);

  function handleScroll() {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 40;
    setUserScrolled(!atBottom);
  }

  function toggleTool(seq: number) {
    setCollapsedTools((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  const toolCount = entries.filter((e) => e.kind === "tool_start").length;
  const errorCount = entries.filter(
    (e) => e.kind === "error" || e.kind === "stderr"
  ).length;

  return (
    <div className={cn("flex flex-col rounded-lg border border-border-dim bg-zinc-950", className)}>
      {/* Toolbar */}
      {!compact && (
        <div className="flex items-center gap-2 border-b border-border-dim px-3 py-2">
          {/* Search */}
          <div className="relative flex-1 max-w-xs">
            <Search
              size={13}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-text-muted"
            />
            <input
              type="text"
              placeholder="Search logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-md border border-border-dim bg-zinc-900 py-1 pl-7 pr-2 text-xs text-text placeholder:text-text-muted focus:border-brand/40 focus:outline-none"
            />
          </div>

          {/* Kind filters */}
          <div className="flex items-center gap-0.5">
            <Filter size={12} className="mr-1 text-text-muted" />
            {FILTER_OPTIONS.map(({ kind, label }) => (
              <button
                key={kind}
                onClick={() => setKindFilter(kind)}
                className={cn(
                  "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
                  kindFilter === kind
                    ? "bg-surface-raised text-text"
                    : "text-text-muted hover:text-text-dim"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Stats */}
          <div className="ml-auto flex gap-3 text-[10px] text-text-muted">
            <span>{entries.length} lines</span>
            {toolCount > 0 && (
              <span className="text-sky-400/60">{toolCount} tools</span>
            )}
            {errorCount > 0 && (
              <span className="text-red-400/60">{errorCount} errors</span>
            )}
          </div>
        </div>
      )}

      {/* Log content */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="overflow-auto p-2 font-mono text-xs leading-relaxed"
        style={{ maxHeight }}
      >
        {filtered.length === 0 ? (
          <span className="text-text-muted px-1">
            {entries.length === 0 ? "Waiting for logs..." : "No matching logs"}
          </span>
        ) : (
          filtered.map((item) =>
            item.type === "group" ? (
              <ToolGroup
                key={item.startSeq}
                group={item}
                collapsed={collapsedTools.has(item.startSeq)}
                onToggle={() => toggleTool(item.startSeq)}
                compact={compact}
              />
            ) : (
              <LogLine
                key={item.entry.seq}
                entry={item.entry}
                compact={compact}
              />
            )
          )
        )}
      </div>

      {/* Scroll-to-bottom button */}
      {userScrolled && (
        <button
          onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight;
              setUserScrolled(false);
            }
          }}
          className="mx-auto mb-1 rounded-full bg-surface-raised px-3 py-0.5 text-[10px] text-text-muted hover:text-text transition-colors"
        >
          Scroll to bottom
        </button>
      )}
    </div>
  );
}

/** Single log line */
function LogLine({
  entry,
  compact,
}: {
  entry: LogEntry;
  compact: boolean;
}) {
  const config = KIND_CONFIG[entry.kind];
  const Icon = config.icon;

  // Skip tool_output and tool_end as standalone -- they're inside groups
  if (entry.kind === "tool_output" || entry.kind === "tool_end") return null;

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded px-1.5 py-0.5",
        config.dimBg
      )}
    >
      {!compact && (
        <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums mt-0.5 w-16">
          {formatTime(entry.ts)}
        </span>
      )}
      <Icon size={12} className={cn("shrink-0 mt-0.5", config.color)} />
      <span className={cn("whitespace-pre-wrap break-all", config.color)}>
        {entry.text}
      </span>
    </div>
  );
}

/** Collapsible tool call group */
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
    <div className="my-0.5">
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-start gap-2 rounded px-1.5 py-0.5 text-left transition-colors hover:bg-zinc-900",
          "bg-sky-500/5"
        )}
      >
        {!compact && (
          <span className="shrink-0 text-[10px] text-zinc-600 tabular-nums mt-0.5 w-16">
            {formatTime(group.entries[0]?.ts ?? "")}
          </span>
        )}
        <Chevron size={12} className="shrink-0 mt-0.5 text-sky-400/60" />
        <Wrench size={12} className="shrink-0 mt-0.5 text-sky-400" />
        <span className="text-sky-400 font-medium">{group.toolName}</span>
        <span className="text-zinc-500 truncate flex-1">{group.summary}</span>
        <span className="shrink-0 flex items-center gap-1.5">
          {group.durationMs !== undefined && (
            <span className="text-[10px] text-zinc-600">
              {group.durationMs > 1000
                ? `${(group.durationMs / 1000).toFixed(1)}s`
                : `${group.durationMs}ms`}
            </span>
          )}
          {group.ok ? (
            <CheckCircle2 size={11} className="text-emerald-500/60" />
          ) : (
            <XCircle size={11} className="text-red-400/60" />
          )}
        </span>
      </button>

      {!collapsed && (
        <div className="ml-6 border-l border-sky-500/10 pl-3 py-0.5">
          {group.entries
            .filter((e) => e.kind === "tool_output")
            .map((e) => (
              <div
                key={e.seq}
                className="text-zinc-600 whitespace-pre-wrap break-all py-0.5 text-[11px]"
              >
                {e.text}
              </div>
            ))}
          {group.entries.filter((e) => e.kind === "tool_output").length ===
            0 && (
            <span className="text-zinc-700 text-[10px]">No output</span>
          )}
        </div>
      )}
    </div>
  );
}

/** Group consecutive tool_start -> tool_output* -> tool_end into blocks */
type ProcessedItem =
  | { type: "line"; entry: LogEntry }
  | ToolGroupData;

function groupToolCalls(entries: LogEntry[]): ProcessedItem[] {
  const result: ProcessedItem[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind === "tool_start") {
      const toolName = (entry.meta?.tool as string) ?? "tool";
      const summary = entry.text;
      const group: LogEntry[] = [entry];
      let ok = true;
      let durationMs: number | undefined;

      // Collect following tool_output and tool_end entries for same tool
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
        summary,
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
