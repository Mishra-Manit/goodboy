/**
 * Renders a pi session transcript: one card per user/assistant/toolResult
 * message, with tool calls paired to their results via `toolCallId`. The
 * viewer owns scroll + autoscroll; everything else is stateless.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@dashboard/lib/utils";
import { LOG_SCROLL_EPSILON_PX } from "@dashboard/lib/constants";
import type { FileEntry } from "@dashboard/lib/api";
import { buildToolResultIndex, visibleEntries } from "./helpers.js";
import { MessageEntry } from "./MessageEntry.js";

interface LogViewerProps {
  entries: FileEntry[];
  className?: string;
  autoScroll?: boolean;
  maxHeight?: string;
}

export function LogViewer({ entries, className, autoScroll = true, maxHeight = "500px" }: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [userScrolled, setUserScrolled] = useState(false);

  const visible = useMemo(() => visibleEntries(entries), [entries]);
  const toolResults = useMemo(() => buildToolResultIndex(visible), [visible]);

  useEffect(() => {
    if (autoScroll && !userScrolled && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [visible, autoScroll, userScrolled]);

  function handleScroll(): void {
    const el = containerRef.current;
    if (!el) return;
    setUserScrolled(el.scrollHeight - el.scrollTop - el.clientHeight > LOG_SCROLL_EPSILON_PX);
  }

  function scrollToBottom(): void {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setUserScrolled(false);
  }

  if (visible.length === 0) {
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
        className="overflow-auto p-3 font-mono text-[11px] leading-[1.7] space-y-2"
        style={{ maxHeight }}
      >
        {visible.map((entry) => (
          <MessageEntry key={entry.id} entry={entry} toolResults={toolResults} />
        ))}
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
