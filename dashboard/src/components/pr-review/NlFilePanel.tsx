/** Left panel of the 2-panel file view. Narrative prose + annotation cards. */

import type { PrReviewAnnotation } from "@dashboard/shared";
import { AnnotationCard } from "./AnnotationCard";

interface NlFilePanelProps {
  narrative: string;
  annotations: PrReviewAnnotation[];
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
}

export function NlFilePanel({ narrative, annotations, onReplyAnnotation }: NlFilePanelProps) {
  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="font-body text-[12.5px] leading-[1.75] text-text-secondary">
        {narrative}
      </p>
      {annotations.length > 0 && (
        <div className="flex flex-col gap-2">
          {annotations.map((annotation, index) => (
            <AnnotationCard
              key={`${annotation.filePath}:${annotation.line}:${index}`}
              annotation={annotation}
              onReply={onReplyAnnotation}
            />
          ))}
        </div>
      )}
    </div>
  );
}
