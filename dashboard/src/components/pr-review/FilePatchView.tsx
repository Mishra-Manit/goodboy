import { PatchDiff, type DiffLineAnnotation } from "@pierre/diffs/react";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { AnnotationCallout } from "./AnnotationCallout";

interface FilePatchViewProps {
  patch: string;
  annotations: PrReviewAnnotation[];
}

type AnnotationMeta = { annotation: PrReviewAnnotation };

export function FilePatchView({ patch, annotations }: FilePatchViewProps) {
  const lineAnnotations: DiffLineAnnotation<AnnotationMeta>[] = annotations.map((annotation) => ({
    side: annotation.side === "old" ? "deletions" : "additions",
    lineNumber: annotation.line,
    metadata: { annotation },
  }));

  return (
    <div className="overflow-hidden rounded-md border border-glass-border">
      <PatchDiff<AnnotationMeta>
        patch={patch}
        options={{
          diffStyle: "unified",
          theme: "github-dark-dimmed",
          themeType: "dark",
          overflow: "scroll",
          lineDiffType: "word",
          disableFileHeader: true,
        }}
        lineAnnotations={lineAnnotations}
        renderAnnotation={(item) => <AnnotationCallout annotation={item.metadata.annotation} />}
      />
    </div>
  );
}
