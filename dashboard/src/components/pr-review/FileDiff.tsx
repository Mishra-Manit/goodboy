/** Single-file split diff with inline pierre annotation comments. */

import { useMemo } from "react";
import { PatchDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { AnnotationComment } from "./AnnotationComment";

interface FileDiffProps {
  filePath: string;
  patch: string | null;
  annotations: PrReviewAnnotation[];
  diffStyle: "split" | "unified";
}

type Meta = { annotation: PrReviewAnnotation };

export function FileDiff({ filePath, patch, annotations, diffStyle }: FileDiffProps) {
  const lineAnnotations: DiffLineAnnotation<Meta>[] = useMemo(
    () =>
      annotations.map((annotation) => ({
        side: annotation.side === "old" ? "deletions" : "additions",
        lineNumber: annotation.line,
        metadata: { annotation },
      })),
    [annotations],
  );

  return (
    <section className="overflow-hidden rounded-md border border-glass-border bg-bg-raised">
      <header className="flex items-center justify-between gap-3 border-b border-glass-border px-3 py-2">
        <span className="truncate font-mono text-[11.5px] text-text-secondary">{filePath}</span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-text-void">
          {annotations.length > 0
            ? `${annotations.length} comment${annotations.length === 1 ? "" : "s"}`
            : "no comments"}
        </span>
      </header>
      {patch ? (
        <PatchDiff<Meta>
          patch={patch}
          options={{
            diffStyle,
            theme: "pierre-dark",
            themeType: "dark",
            overflow: "scroll",
            lineDiffType: "word",
            disableFileHeader: true,
          }}
          lineAnnotations={lineAnnotations}
          renderAnnotation={(item) => <AnnotationComment annotation={item.metadata.annotation} />}
        />
      ) : (
        <div className="p-4 font-mono text-[11px] italic text-text-dim">
          diff unavailable for this file
        </div>
      )}
    </section>
  );
}
