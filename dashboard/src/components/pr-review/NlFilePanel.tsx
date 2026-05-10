/** Left panel of the 2-panel file view. Narrative prose + annotation cards positioned near their target lines. */

import { useEffect, useMemo, useRef, useState } from "react";
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

  // Estimate the minimum height needed to show all annotations without clipping
  const minHeight = useMemo(() => {
    if (sorted.length === 0) return undefined;
    // Compute ideal tops with overlap prevention (using estimated card height)
    const idealTops = sorted.map(a => computeAnnotationTop(a.line, lineToRow));
    const ESTIMATED_CARD_HEIGHT = 140;
    let cursor = 0;
    let lastBottom = 0;
    for (let i = 0; i < idealTops.length; i++) {
      const top = Math.max(idealTops[i], cursor);
      lastBottom = top + ESTIMATED_CARD_HEIGHT;
      cursor = lastBottom + MIN_GAP_PX;
    }
    return lastBottom + 16; // 16px bottom padding
  }, [sorted, lineToRow]);

  return (
    <div className="relative" style={{ minHeight }}>
      {/* Narrative in normal flow */}
      <div className="p-4 pb-2">
        <p className="font-body text-[12.5px] leading-[1.75] text-text-secondary">
          {narrative}
        </p>
      </div>
      {/* Annotations positioned to align with code lines, stacked to avoid overlap */}
      {sorted.length > 0 && (
        <PositionedAnnotations
          annotations={sorted}
          lineToRow={lineToRow}
          onReplyAnnotation={onReplyAnnotation}
        />
      )}
    </div>
  );
}

// --- Positioned Annotations ---

/** Minimum gap between stacked annotation cards. */
const MIN_GAP_PX = 8;

interface PositionedAnnotationsProps {
  annotations: PrReviewAnnotation[];
  lineToRow: Map<number, RowEntry>;
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
}

function PositionedAnnotations({ annotations, lineToRow, onReplyAnnotation }: PositionedAnnotationsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [cardHeights, setCardHeights] = useState<number[]>([]);

  // Measure card heights after render
  useEffect(() => {
    if (!containerRef.current) return;
    const cards = containerRef.current.querySelectorAll(':scope > div');
    const heights = Array.from(cards).map(el => (el as HTMLElement).offsetHeight);
    setCardHeights(prev => {
      if (prev.length === heights.length && prev.every((h, i) => h === heights[i])) return prev;
      return heights;
    });
  });

  // Compute top positions with overlap prevention
  const tops = useMemo(() => {
    const idealTops = annotations.map(a => computeAnnotationTop(a.line, lineToRow));
    const resolved: number[] = [];
    let cursor = 0;

    for (let i = 0; i < idealTops.length; i++) {
      const ideal = idealTops[i];
      const top = Math.max(ideal, cursor);
      resolved.push(top);
      const cardH = cardHeights[i] ?? 120;
      cursor = top + cardH + MIN_GAP_PX;
    }
    return resolved;
  }, [annotations, lineToRow, cardHeights]);

  // Set the parent NlFilePanel's min-height based on actual measured positions
  const totalHeight = useMemo(() => {
    if (tops.length === 0) return 0;
    const lastIdx = tops.length - 1;
    const lastCardH = cardHeights[lastIdx] ?? 120;
    return tops[lastIdx] + lastCardH + 16;
  }, [tops, cardHeights]);

  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (parent && totalHeight > 0) {
      parent.style.minHeight = `${totalHeight}px`;
    }
  }, [totalHeight]);

  return (
    <div ref={containerRef} className="absolute inset-x-0 top-0 px-3">
      {annotations.map((annotation, index) => (
        <div
          key={`${annotation.filePath}:${annotation.line}:${index}`}
          className="absolute left-3 right-3"
          style={{ top: tops[index] ?? 0 }}
        >
          <AnnotationCard annotation={annotation} onReply={onReplyAnnotation} />
        </div>
      ))}
    </div>
  );
}

function computeAnnotationTop(line: number, lineToRow: Map<number, RowEntry>): number {
  const entry = lineToRow.get(line);
  if (entry != null) {
    return DIFF_TOP_PADDING_PX + entry.px;
  }
  return findNearestTop(line, lineToRow);
}

function findNearestTop(targetLine: number, lineToRow: Map<number, RowEntry>): number {
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
