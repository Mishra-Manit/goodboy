/** Annotation card for the NL file panel. Kind-colored stripe, line reference, reply affordance. */

import { Markdown } from "@dashboard/components/Markdown";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { kindStyle } from "./kinds";

interface AnnotationCardProps {
  annotation: PrReviewAnnotation;
  onReply: (annotation: PrReviewAnnotation) => void;
}

export function AnnotationCard({ annotation, onReply }: AnnotationCardProps) {
  const style = kindStyle(annotation.kind);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-l-2 border-glass-border bg-bg-raised",
        style.border,
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-[10px]">
        <span
          className={cn("h-[5px] w-[5px] shrink-0 rounded-full", style.bg)}
          aria-hidden
        />
        <span className={cn("font-mono text-[10px] font-semibold uppercase tracking-[0.18em]", style.text)}>
          {style.label}
        </span>
        <span className="ml-auto font-mono text-[10px] tabular-nums text-text-void">
          line {annotation.line}
        </span>
      </header>

      <div className="px-3 pb-2 pt-[5px]">
        <h4 className="font-display text-[12px] font-medium leading-snug text-text">
          {annotation.title}
        </h4>
        <Markdown
          content={annotation.body}
          className={cn(
            "mt-1 font-body text-[11.5px] leading-[1.6] text-text-secondary",
            "prose-p:my-0.5 prose-code:rounded prose-code:bg-bg-active prose-code:px-1 prose-code:text-[10.5px]",
          )}
        />
      </div>

      <footer className="flex justify-end border-t border-glass-border bg-bg/60 px-2 py-[5px]">
        <button
          type="button"
          onClick={() => onReply(annotation)}
          className="rounded-md px-2 py-[3px] font-mono text-[10px] text-text-dim transition-colors hover:bg-glass hover:text-text"
        >
          Reply
        </button>
      </footer>
    </div>
  );
}
