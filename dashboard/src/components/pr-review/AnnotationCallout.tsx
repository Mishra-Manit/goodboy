import { Markdown } from "@dashboard/components/Markdown";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation } from "@dashboard/shared";

interface AnnotationCalloutProps {
  annotation: PrReviewAnnotation;
}

const KIND_BORDER: Record<PrReviewAnnotation["kind"], string> = {
  user_change: "border-text-ghost",
  goodboy_fix: "border-accent",
  concern: "border-fail",
  note: "border-text-dim",
};

const KIND_LABEL: Record<PrReviewAnnotation["kind"], string> = {
  user_change: "user change",
  goodboy_fix: "goodboy fix",
  concern: "concern",
  note: "note",
};

export function AnnotationCallout({ annotation }: AnnotationCalloutProps) {
  return (
    <div className={cn("my-2 max-w-[660px] border-l-2 py-2 pl-4", KIND_BORDER[annotation.kind])}>
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-dim">
        goodboy · {KIND_LABEL[annotation.kind]}
      </div>
      <div className="mt-1 font-display text-[13.5px] font-medium text-text">
        {annotation.title}
      </div>
      <Markdown
        content={annotation.body}
        className="mt-1 text-[12.5px] leading-relaxed prose-p:my-0 prose-ul:my-1 prose-ol:my-1"
      />
    </div>
  );
}
