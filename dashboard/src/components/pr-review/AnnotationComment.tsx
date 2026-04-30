/** Inline pin trigger: a thin one-line bar with severity badge and excerpt; reveals a floating
 *  popup card on hover/focus. Matches the V8 stacked-diff "tooltip" pattern from Pencil. */

import { Markdown } from "@dashboard/components/Markdown";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { kindStyle } from "./kinds";

interface AnnotationCommentProps {
  annotation: PrReviewAnnotation;
  index: number;
}

export function AnnotationComment({ annotation, index }: AnnotationCommentProps) {
  const style = kindStyle(annotation.kind);
  const lineLabel = `${annotation.side === "old" ? "−" : "+"}${annotation.line}`;

  return (
    <div className="group/pin relative px-3 py-1">
      <button
        type="button"
        className="flex w-full items-center gap-[10px] rounded-md border border-glass-border bg-bg-raised/60 px-[10px] py-[6px] text-left transition-colors hover:border-glass-hover focus:border-accent-dim focus:outline-none"
      >
        <span
          className={cn(
            "flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums text-bg",
            style.text.replace("text-", "bg-"),
          )}
        >
          {index}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] font-semibold uppercase tracking-[0.14em]",
            style.text,
          )}
        >
          {style.label}
        </span>
        <span className="truncate font-body text-[12px] text-text-dim">
          {annotation.title}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-void">
          {lineLabel}
        </span>
      </button>

      <AnnotationPopup annotation={annotation} />
    </div>
  );
}

interface AnnotationPopupProps {
  annotation: PrReviewAnnotation;
}

function AnnotationPopup({ annotation }: AnnotationPopupProps) {
  const style = kindStyle(annotation.kind);
  const lineLabel = `${annotation.side === "old" ? "−" : "+"}${annotation.line}`;

  return (
    <div
      role="tooltip"
      className={cn(
        "pointer-events-none absolute right-3 top-[calc(100%-2px)] z-30 w-[360px]",
        "translate-y-1 scale-[0.98] opacity-0 transition-all duration-150",
        "group-hover/pin:pointer-events-auto group-hover/pin:translate-y-0 group-hover/pin:scale-100 group-hover/pin:opacity-100",
        "group-focus-within/pin:pointer-events-auto group-focus-within/pin:translate-y-0 group-focus-within/pin:scale-100 group-focus-within/pin:opacity-100",
      )}
    >
      <div className="overflow-hidden rounded-lg border border-glass-border bg-bg shadow-[0_18px_40px_rgba(0,0,0,0.6)]">
        <header className="flex items-center gap-2 px-4 pt-[12px]">
          <span
            className={cn(
              "font-mono text-[10px] font-semibold uppercase tracking-[0.16em]",
              style.text,
            )}
          >
            {style.label}
          </span>
          <span className="ml-auto truncate font-mono text-[10px] text-text-void">
            {filenameTail(annotation.filePath)}:{lineLabel}
          </span>
        </header>

        <div className="px-4 pb-3 pt-[6px]">
          <h3 className="font-display text-[13px] font-medium leading-snug text-text">
            {annotation.title}
          </h3>
          <Markdown
            content={annotation.body}
            className={cn(
              "mt-1.5 font-body text-[12px] leading-[1.55] text-text-dim",
              "prose-p:my-1 prose-ul:my-1 prose-ol:my-1",
              "prose-code:rounded prose-code:bg-bg-active prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px]",
            )}
          />
        </div>

        <footer className="flex items-center justify-end gap-1 border-t border-glass-border bg-bg-raised/40 px-2 py-[6px]">
          <button
            type="button"
            className="rounded-md px-2 py-[3px] font-mono text-[10px] text-text-dim transition-colors hover:bg-glass hover:text-text"
          >
            Reply
          </button>
          <button
            type="button"
            className="rounded-md px-2 py-[3px] font-mono text-[10px] text-accent transition-colors hover:bg-accent-ghost"
          >
            Resolve
          </button>
        </footer>
      </div>
    </div>
  );
}

function filenameTail(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
