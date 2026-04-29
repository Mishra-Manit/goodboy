import type { PrReviewChapter } from "@dashboard/shared";

interface ChapterHeaderProps {
  chapter: PrReviewChapter;
  index: number;
}

export function ChapterHeader({ chapter, index }: ChapterHeaderProps) {
  return (
    <div className="mt-8">
      <div className="font-mono text-[12px] uppercase tracking-[0.15em] text-text">
        ─── {String(index + 1).padStart(2, "0")}. {chapter.title}
      </div>
      <p className="mt-3 max-w-[660px] font-body text-[13px] leading-relaxed text-text-secondary">
        {chapter.rationale}
      </p>
    </div>
  );
}
