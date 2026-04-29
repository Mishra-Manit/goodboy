import { useMemo } from "react";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewChapter } from "@dashboard/shared";

interface ChapterTabsProps {
  chapters: PrReviewChapter[];
  orderedIds: string[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function ChapterTabs({ chapters, orderedIds, activeId, onSelect }: ChapterTabsProps) {
  const byId = useMemo(() => new Map(chapters.map((chapter) => [chapter.id, chapter])), [chapters]);

  return (
    <div
      role="tablist"
      aria-label="Review chapters"
      aria-keyshortcuts="j k ArrowLeft ArrowRight"
      className="flex gap-6 overflow-x-auto border-b border-glass-border pb-3"
    >
      {orderedIds.map((id, index) => {
        const chapter = byId.get(id);
        if (!chapter) return null;
        const active = id === activeId;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={active}
            aria-controls={`panel-${id}`}
            onClick={() => onSelect(id)}
            className={cn(
              "whitespace-nowrap text-left font-mono text-[11px] tracking-wide transition-colors",
              active ? "text-text" : "text-text-dim hover:text-text-secondary",
            )}
          >
            <span className={cn("mr-1", active && "text-accent")}>{active ? "▎" : " "}</span>
            {String(index + 1).padStart(2, "0")} ── {chapter.title}
          </button>
        );
      })}
    </div>
  );
}
