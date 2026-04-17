import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { cn } from "@dashboard/lib/utils";
import type { LogEntry, LogEntryKind } from "@dashboard/lib/api";
import { logEntryKey, sortLogEntries } from "@dashboard/lib/logs";
import {
  ChevronRight,
  ChevronDown,
  Terminal,
  FileText,
  Pencil,
  Copy,
  Check,
} from "lucide-react";

/* ── Kind styling ── */

const KIND_COLOR: Record<LogEntryKind, string> = {
  text: "text-text-secondary",
  tool_start: "text-text-secondary",
  tool_update: "text-text-ghost",
  tool_end: "text-text-secondary",
  tool_output: "text-text-ghost",
  stage_info: "text-accent",
  rpc: "text-text-void",
  error: "text-fail",
  stderr: "text-warn",
};

/* ── Tool icons ── */

const TOOL_ICON: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  edit: Pencil,
  write: Pencil,
};

interface LogViewerProps {
  entries: LogEntry[];
  className?: string;
  autoScroll?: boolean;
  maxHeight?: string;
  compact?: boolean;
}

type FilterMode = "all" | "tools" | "text" | "errors";

const PREVIEW_LINES = 12;

export function LogViewer({
  entries,
  className,
  autoScroll = true,
  maxHeight = "500px",
  compact = false,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedTools, setCollapsedTools] = useState(new Set<number>());
  const [userScrolled, setUserScrolled] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("all");

  const normalizedEntries = useMemo(() => sortLogEntries(entries), [entries]);
  const processed = useMemo(() => groupToolCalls(normalizedEntries), [normalizedEntries]);

  const filtered = useMemo(() => {
    if (filter === "all") return processed;
    return processed.filter((item) => {
      if (filter === "tools") return item.type === "group";
      if (filter === "errors") {
        if (item.type === "group") return !item.ok;
        return (
          item.entry.kind === "error" || item.entry.kind === "stderr"
        );
      }
      if (filter === "text") {
        return item.type === "line" && item.entry.kind === "text";
      }
      return true;
    });
  }, [processed, filter]);

  // Stats for filter bar
  const stats = useMemo(() => {
    let tools = 0;
    let errors = 0;
    let text = 0;
    for (const item of processed) {
      if (item.type === "group") {
        tools++;
        if (!item.ok) errors++;
      } else if (
        item.entry.kind === "error" ||
        item.entry.kind === "stderr"
      ) {
        errors++;
      } else if (item.entry.kind === "text") {
        text++;
      }
    }
    return { tools, errors, text };
  }, [processed]);

  useEffect(() => {
    if (autoScroll && !userScrolled && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [normalizedEntries, autoScroll, userScrolled]);

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

  if (normalizedEntries.length === 0) {
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
      {/* Filter bar */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-1 border-b border-glass-border">
        <FilterTab
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label="all"
          count={processed.length}
        />
        <FilterTab
          active={filter === "tools"}
          onClick={() => setFilter("tools")}
          label="tools"
          count={stats.tools}
        />
        <FilterTab
          active={filter === "text"}
          onClick={() => setFilter("text")}
          label="text"
          count={stats.text}
        />
        {stats.errors > 0 && (
          <FilterTab
            active={filter === "errors"}
            onClick={() => setFilter("errors")}
            label="errors"
            count={stats.errors}
            className="text-fail/70"
          />
        )}
      </div>

      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="overflow-auto p-3 font-mono text-[11px] leading-[1.7]"
        style={{ maxHeight }}
      >
        {filtered.map((item) =>
          item.type === "group" ? (
            <ToolGroup
              key={toolGroupKey(item)}
              group={item}
              collapsed={collapsedTools.has(item.startSeq)}
              onToggle={() => toggleTool(item.startSeq)}
              compact={compact}
            />
          ) : (
            <LogLine
              key={logEntryKey(item.entry)}
              entry={item.entry}
              compact={compact}
            />
          )
        )}
      </div>

      {userScrolled && (
        <button
          onClick={() => {
            if (containerRef.current) {
              containerRef.current.scrollTop =
                containerRef.current.scrollHeight;
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

/* ── Filter tab ── */

function FilterTab({
  active,
  onClick,
  label,
  count,
  className: extraClass,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count: number;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-0.5 rounded font-mono text-[10px] transition-all duration-150",
        active
          ? "bg-glass text-text-secondary"
          : "text-text-void hover:text-text-ghost",
        extraClass
      )}
    >
      {label}
      <span className="ml-1 text-text-void">{count}</span>
    </button>
  );
}

/* ── Log line (non-tool) ── */

function LogLine({ entry, compact }: { entry: LogEntry; compact: boolean }) {
  if (entry.kind === "tool_output" || entry.kind === "tool_end" || entry.kind === "tool_update") return null;

  // Skip raw JSON tool events that leaked through
  if (entry.kind === "text" && isRawToolJson(entry.text)) return null;

  const isStage = entry.kind === "stage_info";
  const isError = entry.kind === "error" || entry.kind === "stderr";

  return (
    <div
      className={cn(
        "flex items-start gap-2 py-px",
        isStage && "py-1.5 mt-1",
        isError && "bg-fail-dim/30 rounded px-1 -mx-1"
      )}
    >
      {!compact && (
        <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px] mt-px">
          {formatTime(entry.ts)}
        </span>
      )}
      {isStage ? (
        <span className="text-accent font-medium text-[10px]">
          {entry.text}
        </span>
      ) : (
        <span
          className={cn(
            "whitespace-pre-wrap break-all",
            KIND_COLOR[entry.kind]
          )}
        >
          {entry.text}
        </span>
      )}
    </div>
  );
}

/* ── Tool call groups ── */

interface ToolGroupData {
  type: "group";
  startSeq: number;
  toolName: string;
  toolCallId?: string;
  summary: string;
  entries: LogEntry[];
  ok: boolean;
  durationMs?: number;
  /** True once a tool_end entry has been seen for this group. */
  done: boolean;
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
  if (group.toolName === "subagent") {
    return (
      <SubagentCard
        group={group}
        collapsed={collapsed}
        onToggle={onToggle}
        compact={compact}
      />
    );
  }

  const Icon = TOOL_ICON[group.toolName] ?? Terminal;
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  const outputText = useMemo(() => extractToolOutput(group.entries), [group.entries]);
  const displaySummary = useMemo(
    () => formatToolSummary(group.toolName, group.summary),
    [group.toolName, group.summary]
  );

  return (
    <div className={cn("py-0.5", !group.ok && "")}>
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors",
          "hover:bg-glass",
          !group.ok && "bg-fail-dim/20"
        )}
      >
        {!compact && (
          <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px]">
            {formatTime(group.entries[0]?.ts ?? "")}
          </span>
        )}

        <Icon size={11} className="shrink-0 text-text-void" />

        <span className="shrink-0 text-text-dim font-medium text-[11px]">
          {group.toolName}
        </span>

        <span className="flex-1 truncate text-text-ghost text-[10px]">
          {displaySummary}
        </span>

        <span className="shrink-0 flex items-center gap-2">
          {group.durationMs !== undefined && (
            <span className="text-text-void text-[10px] tabular-nums">
              {group.durationMs > 1000
                ? `${(group.durationMs / 1000).toFixed(1)}s`
                : `${group.durationMs}ms`}
            </span>
          )}
          <span
            className={cn(
              "text-[9px] font-medium px-1 py-px rounded",
              group.ok
                ? "text-ok/70 bg-ok-dim"
                : "text-fail/70 bg-fail-dim"
            )}
          >
            {group.ok ? "ok" : "err"}
          </span>
          <Chevron size={10} className="text-text-void" />
        </span>
      </button>

      {!collapsed && (
        <ToolOutput
          text={outputText}
          ok={group.ok}
        />
      )}
    </div>
  );
}

/* ── Subagent card ── live parallel-worker render for subagent tool calls ── */

interface SubagentWorkerSnapshot {
  index: number;
  agent: string;
  status: string;
  task: string;
  currentTool?: string;
  toolCount: number;
  tokens: number;
  durationMs: number;
  error?: string;
  finalOutput?: string;
}

function SubagentCard({
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
  const startEntry = group.entries[0];
  const endEntry = group.entries.find((e) => e.kind === "tool_end");
  const latestUpdate = [...group.entries].reverse().find((e) => e.kind === "tool_update");
  const outputs = group.entries.filter((e) => e.kind === "tool_output");

  const mode = (startEntry.meta?.mode as string) ?? "parallel";
  const taskCount = (startEntry.meta?.taskCount as number) ?? 0;
  const startTasks = (startEntry.meta?.tasks as Array<{ agent: string; task: string }>) ?? [];

  // Merge live progress with final outputs. Prefer final outputs when present.
  const workers = useMemo<SubagentWorkerSnapshot[]>(() => {
    const progress = (latestUpdate?.meta?.progress as SubagentWorkerSnapshot[] | undefined) ?? [];

    // Seed from startTasks so we always show the right number of slots.
    const seeded: SubagentWorkerSnapshot[] = startTasks.map((t, i) => ({
      index: i,
      agent: t.agent,
      status: "pending",
      task: t.task,
      toolCount: 0,
      tokens: 0,
      durationMs: 0,
    }));

    for (const p of progress) {
      if (typeof p.index === "number" && seeded[p.index]) {
        seeded[p.index] = { ...seeded[p.index], ...p };
      }
    }

    for (const o of outputs) {
      const idx = o.meta?.workerIndex as number | undefined;
      if (idx === undefined || !seeded[idx]) continue;
      seeded[idx] = {
        ...seeded[idx],
        status: (o.meta?.status as string) ?? seeded[idx].status,
        tokens: (o.meta?.tokens as number | undefined) ?? seeded[idx].tokens,
        durationMs: (o.meta?.durationMs as number | undefined) ?? seeded[idx].durationMs,
        error: (o.meta?.error as string | undefined) ?? seeded[idx].error,
        finalOutput: o.text,
      };
    }

    return seeded;
  }, [startTasks, latestUpdate, outputs]);

  const completedCount = (endEntry?.meta?.completedCount as number | undefined) ?? workers.filter((w) => w.status === "completed").length;
  const failedCount = (endEntry?.meta?.failedCount as number | undefined) ?? workers.filter((w) => w.status === "failed").length;
  const totalCost = (endEntry?.meta?.totalCost as number | undefined) ?? 0;

  const header = group.done
    ? `${completedCount}/${taskCount} ok${failedCount > 0 ? ` \u00b7 ${failedCount} failed` : ""}`
    : `${workers.filter((w) => w.status === "running").length} running \u00b7 ${completedCount} done${failedCount > 0 ? ` \u00b7 ${failedCount} failed` : ""}`;

  return (
    <div className={cn("py-0.5")}>
      <button
        onClick={onToggle}
        className={cn(
          "flex w-full items-center gap-2 text-left rounded px-1 -mx-1 py-0.5 transition-colors",
          "hover:bg-glass",
          group.done && failedCount > 0 && "bg-fail-dim/20",
          !group.done && "bg-accent-dim/10"
        )}
      >
        {!compact && (
          <span className="shrink-0 w-14 text-text-void tabular-nums text-[10px]">
            {formatTime(group.entries[0]?.ts ?? "")}
          </span>
        )}

        <Terminal size={11} className="shrink-0 text-accent" />

        <span className="shrink-0 text-text-dim font-medium text-[11px]">
          subagent
        </span>

        <span className="shrink-0 text-text-ghost text-[10px]">
          {mode} ({taskCount})
        </span>

        <span className="flex-1 truncate text-text-ghost text-[10px]">
          {header}
        </span>

        <span className="shrink-0 flex items-center gap-2">
          {group.durationMs !== undefined && (
            <span className="text-text-void text-[10px] tabular-nums">
              {group.durationMs > 1000 ? `${(group.durationMs / 1000).toFixed(1)}s` : `${group.durationMs}ms`}
            </span>
          )}
          {totalCost > 0 && (
            <span className="text-text-void text-[10px] tabular-nums">
              ${totalCost.toFixed(4)}
            </span>
          )}
          <span
            className={cn(
              "text-[9px] font-medium px-1 py-px rounded",
              !group.done
                ? "text-accent/70 bg-accent-dim/40"
                : group.ok
                ? "text-ok/70 bg-ok-dim"
                : "text-fail/70 bg-fail-dim"
            )}
          >
            {!group.done ? "running" : group.ok ? "ok" : "err"}
          </span>
          <Chevron size={10} className="text-text-void" />
        </span>
      </button>

      {!collapsed && (
        <div className="ml-[76px] pl-3 py-1 border-l border-glass-border space-y-1">
          {workers.map((w) => (
            <SubagentWorkerRow key={w.index} worker={w} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentWorkerRow({ worker }: { worker: SubagentWorkerSnapshot }) {
  const [expanded, setExpanded] = useState(false);

  const statusLabel =
    worker.status === "completed" ? "done"
    : worker.status === "failed" ? "failed"
    : worker.status === "running" ? "running"
    : "pending";

  const statusClass =
    worker.status === "completed" ? "text-ok/70"
    : worker.status === "failed" ? "text-fail/70"
    : worker.status === "running" ? "text-accent/80"
    : "text-text-void";

  const liveLine =
    worker.status === "running"
      ? `${worker.currentTool ? `${worker.currentTool} \u00b7 ` : ""}${worker.toolCount} tools \u00b7 ${formatTokens(worker.tokens)} tok${worker.durationMs > 0 ? ` \u00b7 ${formatDuration(worker.durationMs)}` : ""}`
      : worker.status === "completed"
      ? `${worker.toolCount} tools \u00b7 ${formatTokens(worker.tokens)} tok${worker.durationMs > 0 ? ` \u00b7 ${formatDuration(worker.durationMs)}` : ""}`
      : worker.status === "failed"
      ? worker.error ?? "failed"
      : "waiting";

  const hasOutput = !!worker.finalOutput && worker.finalOutput.length > 0;

  return (
    <div className="py-0.5">
      <button
        onClick={() => hasOutput && setExpanded((v) => !v)}
        className={cn(
          "flex w-full items-start gap-2 text-left rounded px-1 -mx-1 py-0.5",
          hasOutput && "hover:bg-glass cursor-pointer"
        )}
        disabled={!hasOutput}
      >
        <span className={cn("shrink-0 text-[9px] font-medium px-1 py-px rounded tabular-nums", statusClass)}>
          {statusLabel}
        </span>
        <span className="shrink-0 text-text-void text-[10px] tabular-nums w-5">
          #{worker.index + 1}
        </span>
        <span className="flex-1 text-text-ghost text-[10px] truncate">
          {worker.task}
        </span>
        <span className="shrink-0 text-text-void text-[10px]">
          {liveLine}
        </span>
      </button>

      {expanded && hasOutput && (
        <div className="ml-4 mt-1 py-1 px-2 bg-bg rounded text-[10px] text-text-secondary whitespace-pre-wrap break-words">
          {worker.finalOutput}
        </div>
      )}
    </div>
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${tokens}`;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/* ── Tool output renderer ── */

function ToolOutput({
  text,
  ok,
}: {
  text: string;
  ok: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);

  if (!text || text === "(no output)") {
    return (
      <div className="ml-[76px] pl-3 py-0.5 border-l border-glass-border">
        <span className="text-text-void text-[10px] italic">no output</span>
      </div>
    );
  }

  const lines = text.split("\n");
  const isLong = lines.length > PREVIEW_LINES;
  const displayLines = expanded || !isLong ? lines : lines.slice(0, PREVIEW_LINES);
  const isDiff = detectDiff(text);
  const isFileList = detectFileList(text);

  return (
    <div
      className={cn(
        "ml-[76px] border-l pl-3 py-1 relative group",
        ok ? "border-glass-border" : "border-fail/20"
      )}
    >
      {/* Copy button */}
      <button
        onClick={handleCopy}
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-glass"
        title="Copy output"
      >
        {copied ? (
          <Check size={10} className="text-ok" />
        ) : (
          <Copy size={10} className="text-text-void" />
        )}
      </button>

      <div className="overflow-x-auto">
        {displayLines.map((line, i) => (
          <div key={i} className="py-px">
            <OutputLine
              line={line}
              isDiff={isDiff}
              isFileList={isFileList}
              isError={!ok}
            />
          </div>
        ))}
      </div>

      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[9px] text-text-ghost hover:text-accent transition-colors"
        >
          {expanded ? "collapse" : `show ${lines.length - PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

/* ── Output line with smart formatting ── */

function OutputLine({
  line,
  isDiff,
  isFileList,
  isError,
}: {
  line: string;
  isDiff: boolean;
  isFileList: boolean;
  isError: boolean;
}) {
  if (isError) {
    return (
      <span className="text-[10px] text-fail/70 whitespace-pre-wrap break-all">
        {line}
      </span>
    );
  }

  // Diff coloring
  if (isDiff) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      return (
        <span className="text-[10px] text-ok/70 whitespace-pre">{line}</span>
      );
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      return (
        <span className="text-[10px] text-fail/60 whitespace-pre">
          {line}
        </span>
      );
    }
    if (line.startsWith("@@")) {
      return (
        <span className="text-[10px] text-info/50 whitespace-pre">
          {line}
        </span>
      );
    }
  }

  // File list -- highlight paths
  if (isFileList && line.match(/^[\w./-]+\.\w+$/)) {
    return (
      <span className="text-[10px] text-text-dim whitespace-pre">{line}</span>
    );
  }

  return (
    <span className="text-[10px] text-text-void whitespace-pre-wrap break-all">
      {line}
    </span>
  );
}

/* ── Grouping logic ── */

type ProcessedItem = { type: "line"; entry: LogEntry } | ToolGroupData;

function toolGroupKey(group: ToolGroupData): string {
  const firstEntry = group.entries[0];
  return `${firstEntry?.ts ?? ""}:${group.startSeq}:${group.toolCallId ?? group.toolName}`;
}

/**
 * Correlate tool lifecycle entries by toolCallId (preferred) or tool name
 * (fallback for old logs that predate toolCallId in meta). A match pulls the
 * entry into the group regardless of kind -- includes tool_update,
 * tool_output, tool_end, and legacy text-carried raw JSON tool events.
 */
function groupToolCalls(entries: LogEntry[]): ProcessedItem[] {
  const result: ProcessedItem[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    if (entry.kind === "tool_start") {
      const toolName = (entry.meta?.tool as string) ?? "tool";
      const toolCallId = entry.meta?.toolCallId as string | undefined;
      const group: LogEntry[] = [entry];
      let ok = true;
      let durationMs: number | undefined;
      let done = false;

      const matches = (e: LogEntry): boolean => {
        if (toolCallId && e.meta?.toolCallId === toolCallId) return true;
        if (!toolCallId && e.meta?.tool === toolName) return true;
        return false;
      };

      let j = i + 1;
      while (j < entries.length) {
        const next = entries[j];
        if (
          (next.kind === "tool_output" || next.kind === "tool_update") &&
          matches(next)
        ) {
          group.push(next);
          j++;
        } else if (next.kind === "tool_end" && matches(next)) {
          group.push(next);
          ok = (next.meta?.ok as boolean) ?? true;
          durationMs = next.meta?.durationMs as number | undefined;
          done = true;
          j++;
          break;
        } else if (next.kind === "text" && isRawToolJson(next.text)) {
          group.push(next);
          j++;
        } else {
          break;
        }
      }

      result.push({
        type: "group",
        startSeq: entry.seq,
        toolName,
        toolCallId,
        summary: entry.text,
        entries: group,
        ok,
        durationMs,
        done,
      });
      i = j;
    } else {
      result.push({ type: "line", entry });
      i++;
    }
  }

  return result;
}

/* ── Extract meaningful text from tool output entries ── */

function extractToolOutput(entries: LogEntry[]): string {
  const toolOutputEntries = entries.filter((e) => e.kind === "tool_output");
  if (toolOutputEntries.length > 0) {
    return toolOutputEntries.map((e) => e.text).join("\n");
  }

  for (const entry of entries) {
    if (entry.kind === "text" && isRawToolJson(entry.text)) {
      const extracted = extractTextFromToolJson(entry.text);
      if (extracted) return extracted;
    }
  }

  return "(no output)";
}

/* ── Parse tool execution JSON and extract just the useful content ── */

function extractTextFromToolJson(raw: string): string | null {
  try {
    const obj = JSON.parse(raw);
    if (obj?.result?.content) {
      const texts: string[] = [];
      for (const block of obj.result.content) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        }
      }
      if (texts.length > 0) return texts.join("\n");
    }
    if (typeof obj?.result === "string") return obj.result;
    return null;
  } catch {
    return null;
  }
}

/* ── Detect if text is a raw tool event JSON ── */

function isRawToolJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return false;
  if (
    !trimmed.includes('"tool_execution_end"') &&
    !trimmed.includes('"tool_execution_start"') &&
    !trimmed.includes('"tool_call"')
  ) {
    return false;
  }
  try {
    const obj = JSON.parse(trimmed);
    return (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.type === "string" &&
      (obj.type === "tool_execution_end" ||
        obj.type === "tool_execution_start" ||
        obj.type === "tool_call")
    );
  } catch {
    return false;
  }
}

/* ── Format tool summary for display ── */

function formatToolSummary(toolName: string, raw: string): string {
  if (toolName === "bash" && raw.length > 120) return raw.slice(0, 120) + "...";
  return raw;
}

/* ── Content detection helpers ── */

function detectDiff(text: string): boolean {
  const lines = text.split("\n").slice(0, 10);
  let diffMarkers = 0;
  for (const line of lines) {
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith("@@")) {
      diffMarkers++;
    }
  }
  return diffMarkers >= 3;
}

function detectFileList(text: string): boolean {
  const lines = text.split("\n").slice(0, 10);
  let pathCount = 0;
  for (const line of lines) {
    if (line.match(/^[\w./-]+\.\w{1,6}$/)) pathCount++;
  }
  return pathCount >= 3;
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
