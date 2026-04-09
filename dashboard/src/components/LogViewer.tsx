import { useEffect, useRef } from "react";
import { cn } from "@dashboard/lib/utils";

interface LogViewerProps {
  lines: string[];
  className?: string;
  autoScroll?: boolean;
  maxHeight?: string;
}

export function LogViewer({
  lines,
  className,
  autoScroll = true,
  maxHeight = "400px",
}: LogViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "overflow-auto rounded-md border border-border-dim bg-zinc-950 p-3 font-mono text-xs leading-5",
        className
      )}
      style={{ maxHeight }}
    >
      {lines.length === 0 ? (
        <span className="text-text-muted">No logs yet</span>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="text-text-dim whitespace-pre-wrap break-all">
            {line}
          </div>
        ))
      )}
    </div>
  );
}
