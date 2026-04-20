/** Collapsible, diff-aware renderer for a tool's output text. */

import { useCallback, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import { LOG_PREVIEW_LINES } from "@dashboard/lib/constants";
import { detectDiff, detectFileList } from "@dashboard/lib/log-grouping";

interface ToolOutputProps {
  text: string;
  ok: boolean;
}

export function ToolOutput({ text, ok }: ToolOutputProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(text)
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
  const isLong = lines.length > LOG_PREVIEW_LINES;
  const shown = expanded || !isLong ? lines : lines.slice(0, LOG_PREVIEW_LINES);
  const classify = lineClassifier({ isDiff: detectDiff(text), isFileList: detectFileList(text), ok });

  return (
    <div
      className={cn(
        "ml-[76px] border-l pl-3 py-1 relative group",
        ok ? "border-glass-border" : "border-fail/20",
      )}
    >
      <button
        onClick={handleCopy}
        title="Copy output"
        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-glass"
      >
        {copied ? <Check size={10} className="text-ok" /> : <Copy size={10} className="text-text-void" />}
      </button>

      <div className="overflow-x-auto">
        {shown.map((line, i) => (
          <div key={i} className={cn("py-px text-[10px]", classify(line))}>
            {line}
          </div>
        ))}
      </div>

      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[9px] text-text-ghost hover:text-accent transition-colors"
        >
          {expanded ? "collapse" : `show ${lines.length - LOG_PREVIEW_LINES} more lines`}
        </button>
      )}
    </div>
  );
}

// --- Helpers ---

interface LineContext {
  isDiff: boolean;
  isFileList: boolean;
  ok: boolean;
}

/** Pick a className for one output line based on content sniffing done once per output. */
function lineClassifier({ isDiff, isFileList, ok }: LineContext) {
  return (line: string): string => {
    if (!ok) return "text-fail/70 whitespace-pre-wrap break-all";

    if (isDiff) {
      if (line.startsWith("+") && !line.startsWith("+++")) return "text-ok/70 whitespace-pre";
      if (line.startsWith("-") && !line.startsWith("---")) return "text-fail/60 whitespace-pre";
      if (line.startsWith("@@")) return "text-info/50 whitespace-pre";
    }

    if (isFileList && /^[\w./-]+\.\w+$/.test(line)) return "text-text-dim whitespace-pre";

    return "text-text-void whitespace-pre-wrap break-all";
  };
}
