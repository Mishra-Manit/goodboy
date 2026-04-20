/**
 * Container for a live log stream. Owns scroll + filter + collapse state and
 * delegates rendering to `<LogLine>` and `<ToolGroup>`. All pure processing
 * lives in `lib/log-grouping.ts`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@dashboard/lib/utils";
import { LOG_SCROLL_EPSILON_PX } from "@dashboard/lib/constants";
import { logEntryKey, sortLogEntries } from "@dashboard/lib/logs";
import { groupToolCalls, toolGroupKey } from "@dashboard/lib/log-grouping";
import type { LogEntry } from "@dashboard/lib/api";
import { FilterBar, type FilterMode } from "./FilterBar.js";
import { LogLine } from "./LogLine.js";
import { ToolGroup } from "./ToolGroup.js";
import type { ProcessedItem } from "@dashboard/lib/log-grouping";

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
  maxHeight = "500px",
  compact = false,
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [collapsedTools, setCollapsedTools] = useState(new Set<number>());
  const [userScrolled, setUserScrolled] = useState(false);
  const [filter, setFilter] = useState<FilterMode>("all");

  const sorted = useMemo(() => sortLogEntries(entries), [entries]);
  const processed = useMemo(() => groupToolCalls(sorted), [sorted]);
  const counts = useMemo(() => countByFilter(processed), [processed]);

  const filtered = useMemo(
    () => (filter === "all" ? processed : processed.filter(FILTERS[filter])),
    [processed, filter],
  );

  useEffect(() => {
    if (autoScroll && !userScrolled && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [sorted, autoScroll, userScrolled]);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    setUserScrolled(el.scrollHeight - el.scrollTop - el.clientHeight > LOG_SCROLL_EPSILON_PX);
  }

  function toggleTool(seq: number) {
    setCollapsedTools((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });
  }

  function scrollToBottom() {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setUserScrolled(false);
  }

  if (sorted.length === 0) {
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
      <FilterBar
        filter={filter}
        onChange={setFilter}
        counts={{ all: processed.length, ...counts }}
      />

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
            <LogLine key={logEntryKey(item.entry)} entry={item.entry} compact={compact} />
          ),
        )}
      </div>

      {userScrolled && (
        <button
          onClick={scrollToBottom}
          className="mx-auto mb-2 block font-mono text-[9px] text-text-ghost hover:text-text-dim transition-colors"
        >
          scroll to bottom
        </button>
      )}
    </div>
  );
}

// --- Helpers ---

const FILTERS: Record<Exclude<FilterMode, "all">, (item: ProcessedItem) => boolean> = {
  tools: (item) => item.type === "group",
  text: (item) => item.type === "line" && item.entry.kind === "text",
  errors: (item) =>
    item.type === "group" ? !item.ok : item.entry.kind === "error" || item.entry.kind === "stderr",
};

function countByFilter(items: ProcessedItem[]) {
  return {
    tools: items.filter(FILTERS.tools).length,
    text: items.filter(FILTERS.text).length,
    errors: items.filter(FILTERS.errors).length,
  };
}
