/**
 * One assistant turn: interleaves text, thinking, and tool-call content blocks
 * in their original order. Tool calls display their matching `ToolResultMessage`
 * inline via `<ToolCallCard>`.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@dashboard/lib/utils";
import type {
  AssistantMessage,
  TextContent,
  ThinkingContent,
  SessionMessageEntry,
} from "@dashboard/lib/api";
import { ToolCallCard } from "./ToolCallCard.js";

interface AssistantTurnProps {
  message: AssistantMessage;
  toolResults: Map<string, SessionMessageEntry>;
  compact?: boolean;
}

export function AssistantTurn({ message, toolResults, compact = false }: AssistantTurnProps) {
  return (
    <div className="space-y-1.5">
      {message.content.map((block, i) => {
        if (block.type === "text") {
          if (compact) return <CompactTextBlock key={i} block={block} />;
          return <TextBlock key={i} block={block} />;
        }
        if (block.type === "thinking") return <ThinkingBlock key={i} block={block} />;
        if (block.type === "toolCall") {
          const result = toolResults.get(block.id);
          const resultMessage =
            result && result.message.role === "toolResult" ? result.message : undefined;
          return <ToolCallCard key={i} call={block} result={resultMessage} />;
        }
        return null;
      })}
      {message.errorMessage && (
        <div className="rounded-md bg-fail-dim px-3 py-2 text-[11px] text-fail/80 whitespace-pre-wrap">
          {message.errorMessage}
        </div>
      )}
    </div>
  );
}

// --- Blocks ---

function TextBlock({ block }: { block: TextContent }) {
  if (!block.text.trim()) return null;
  return (
    <div className="whitespace-pre-wrap text-text-secondary text-[11px] leading-relaxed">
      {block.text}
    </div>
  );
}

function CompactTextBlock({ block }: { block: TextContent }) {
  const [expanded, setExpanded] = useState(false);
  if (!block.text.trim()) return null;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-1 text-[10px] text-text-ghost hover:text-text-dim transition-colors",
        )}
      >
        <Chevron size={10} />
        <span>text-output</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-3 border-l border-glass-border pl-2 py-1 text-text-secondary text-[10px] whitespace-pre-wrap leading-relaxed">
          {block.text}
        </div>
      )}
    </div>
  );
}

function ThinkingBlock({ block }: { block: ThinkingContent }) {
  const [expanded, setExpanded] = useState(false);
  if (!block.thinking.trim()) return null;
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div>
      <button
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex items-center gap-1 text-[10px] text-text-ghost hover:text-text-dim transition-colors",
        )}
      >
        <Chevron size={10} />
        <span>thinking</span>
      </button>
      {expanded && (
        <div className="mt-1 ml-3 border-l border-glass-border pl-2 py-1 text-text-ghost text-[10px] whitespace-pre-wrap">
          {block.thinking}
        </div>
      )}
    </div>
  );
}

