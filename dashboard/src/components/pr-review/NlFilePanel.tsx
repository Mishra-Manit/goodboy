/** Left panel of the 2-panel file view. Narrative prose + annotation cards positioned near their target lines. */

import { useMemo } from "react";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { AnnotationCard } from "./AnnotationCard";

/** Line height of the @pierre/diffs component (from its CSS: --diffs-line-height: 20px). */
const DIFF_LINE_HEIGHT_PX = 20;

/** Top padding inside [data-code] (--diffs-gap-fallback: 8px). */
const DIFF_TOP_PADDING_PX = 8;

/** Height of a hunk separator in the rendered diff (data-separator=simple: 4px + block margins). */
const SEPARATOR_HEIGHT_PX = 4;

interface NlFilePanelProps {
  narrative: string;
  annotations: PrReviewAnnotation[];
  patch: string | null;
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
}

export function NlFilePanel({ narrative, annotations, patch, onReplyAnnotation }: NlFilePanelProps) {
  const lineToRow = useMemo(() => buildLineToRowMap(patch), [patch]);
  const sorted = useMemo(
    () => [...annotations].sort((a, b) => a.line - b.line),
    [annotations],
  );

  return (
    <div className="relative">
      {/* Narrative in normal flow */}
      <div className="p-4 pb-2">
        <p className="font-body text-[12.5px] leading-[1.75] text-text-secondary">
          {narrative}
        </p>
      </div>
      {/* Annotations absolutely positioned to align with code lines */}
      {sorted.length > 0 && (
        <div className="absolute inset-x-0 top-0 px-3">
          {sorted.map((annotation, index) => {
            const top = computeAnnotationTop(annotation.line, lineToRow);
            return (
              <div
                key={`${annotation.filePath}:${annotation.line}:${index}`}
                className="absolute left-3 right-3"
                style={{ top }}
              >
                <AnnotationCard annotation={annotation} onReply={onReplyAnnotation} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Positioning ---

function computeAnnotationTop(line: number, lineToRow: Map<number, number>): number {
  const entry = lineToRow.get(line);
  if (entry != null) {
    return DIFF_TOP_PADDING_PX + entry.px;
  }
  // Line not directly in patch — find nearest preceding visible line
  return findNearestTop(line, lineToRow);
}

function findNearestTop(targetLine: number, lineToRow: Map<number, number>): number {
  let bestLine = 0;
  let bestPx = 0;
  for (const [line, { px }] of lineToRow) {
    if (line <= targetLine && line > bestLine) {
      bestLine = line;
      bestPx = px;
    }
  }
  const extraRows = targetLine - bestLine;
  return DIFF_TOP_PADDING_PX + bestPx + extraRows * DIFF_LINE_HEIGHT_PX;
}

// --- Patch Parsing ---

interface RowEntry {
  /** Pixel offset from the top of the code container. */
  px: number;
}

/** Build a map from new-file line number → pixel offset in the rendered diff. */
function buildLineToRowMap(patch: string | null): Map<number, RowEntry> {
  const map = new Map<number, RowEntry>();
  if (!patch) return map;

  let px = 0;
  let lineNum = 0;
  let isFirstHunk = true;

  const lines = patch.split("\n");
  // Trim trailing empty lines from split
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("@@")) {
      const match = line.match(/\+(\d+)/);
      lineNum = match ? Number(match[1]) : 0;
      // First hunk has no separator above it; subsequent hunks add a separator
      if (!isFirstHunk) {
        px += SEPARATOR_HEIGHT_PX;
      }
      isFirstHunk = false;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("-")) {
      // Deleted line: occupies visual space but no new-file line number
      px += DIFF_LINE_HEIGHT_PX;
      continue;
    }
    // Context or addition line
    map.set(lineNum, { px });
    lineNum++;
    px += DIFF_LINE_HEIGHT_PX;
  }

  return map;
}
