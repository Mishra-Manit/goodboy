/** Single-file split diff with hover-triggered annotation popups. */

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

type Meta = { annotation: PrReviewAnnotation; index: number };

export function FileDiff({ filePath, patch, annotations, diffStyle }: FileDiffProps) {
  const lineAnnotations: DiffLineAnnotation<Meta>[] = useMemo(
    () =>
      annotations.map((annotation, index) => ({
        side: annotation.side === "old" ? "deletions" : "additions",
        lineNumber: annotation.line,
        metadata: { annotation, index: index + 1 },
      })),
    [annotations],
  );

  return (
    <section className="overflow-hidden bg-bg-raised">
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
          renderAnnotation={(item) => (
            <AnnotationComment
              annotation={item.metadata.annotation}
              index={item.metadata.index}
            />
          )}
        />
      ) : (
        <div className="p-4 font-mono text-[11px] italic text-text-dim">
          diff unavailable for {filePath}
        </div>
      )}
    </section>
  );
}
