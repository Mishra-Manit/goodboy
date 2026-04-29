/** Inline review comment, rendered inside Pierre's renderAnnotation row slot. */

import { Markdown } from "@dashboard/components/Markdown";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { kindStyle } from "./kinds";

interface AnnotationCommentProps {
  annotation: PrReviewAnnotation;
}

export function AnnotationComment({ annotation }: AnnotationCommentProps) {
  const style = kindStyle(annotation.kind);
  return (
    <div className="px-3 py-2">
      <article
        className={cn(
          "rounded-md border border-glass-border bg-bg-raised border-l-2",
          style.border,
        )}
      >
        <header className="flex items-center gap-2 border-b border-glass-border px-3 py-1.5">
          <span className={cn("h-1.5 w-1.5 rounded-full", style.text.replace("text-", "bg-"))} />
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]",
              style.bg,
              style.text,
            )}
          >
            {style.label}
          </span>
          <span className="font-mono text-[10.5px] text-text-void">goodboy</span>
          <span className="ml-auto font-mono text-[10.5px] text-text-void">
            {annotation.side === "old" ? "−" : "+"}
            {annotation.line}
          </span>
        </header>
        <div className="px-3 py-2">
          <h3 className="font-display text-[13px] font-medium leading-snug text-text">
            {annotation.title}
          </h3>
          <Markdown
            content={annotation.body}
            className="mt-1.5 text-[12px] leading-relaxed text-text-secondary prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-code:text-[10.5px] prose-code:bg-bg-active prose-code:px-1 prose-code:py-0.5 prose-code:rounded"
          />
        </div>
      </article>
    </div>
  );
}
