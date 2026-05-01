/** Single-file split diff. Annotations turn the affected line purple via inline styles
 *  applied in `onPostRender` (shadow-DOM, beats pierre's cascade layers without specificity
 *  fights) and surface a portaled glass popup on hover that carries the kind-color signal. */

import { useCallback, useMemo, useRef, useState } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { AnnotationPopup } from "./AnnotationPopup";

interface FileDiffProps {
  filePath: string;
  patch: string | null;
  annotations: PrReviewAnnotation[];
  diffStyle: "split" | "unified";
  onReplyAnnotation: (annotation: PrReviewAnnotation) => void;
}

type AnnotationSide = "additions" | "deletions";
type AnnotationKey = `${AnnotationSide}:${number}`;

interface ActiveAnnotation {
  annotation: PrReviewAnnotation;
  rect: DOMRect;
}

const CLOSE_DELAY_MS = 120;

export function FileDiff({ filePath, patch, annotations, diffStyle, onReplyAnnotation }: FileDiffProps) {
  const lookup = useMemo(() => buildLookup(annotations), [annotations]);

  const [active, setActive] = useState<ActiveAnnotation | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      setActive(null);
      closeTimerRef.current = null;
    }, CLOSE_DELAY_MS);
  }, [cancelClose]);

  const paintRows = useCallback(
    (node: HTMLElement) => {
      const root = node.shadowRoot ?? node;
      paintCommentRows(root, annotations);
    },
    [annotations],
  );

  const options = useMemo(
    () => ({
      diffStyle,
      theme: "github-dark-high-contrast" as const,
      themeType: "dark" as const,
      overflow: "scroll" as const,
      lineDiffType: "word" as const,
      disableFileHeader: true,
      hunkSeparators: "simple" as const,
      onPostRender: (node: HTMLElement) => paintRows(node),
      onLineEnter: ({ lineNumber, annotationSide, lineElement }: {
        lineNumber: number;
        annotationSide: AnnotationSide;
        lineElement: HTMLElement;
      }) => {
        const annotation = lookup.get(toKey(annotationSide, lineNumber));
        if (!annotation) return;
        cancelClose();
        setActive({ annotation, rect: anchorRectFor(lineElement) });
      },
      onLineLeave: ({ lineNumber, annotationSide }: {
        lineNumber: number;
        annotationSide: AnnotationSide;
      }) => {
        if (lookup.has(toKey(annotationSide, lineNumber))) scheduleClose();
      },
    }),
    [diffStyle, lookup, paintRows, cancelClose, scheduleClose],
  );

  return (
    <section className="relative overflow-hidden bg-bg-raised">
      {patch ? (
        <PatchDiff patch={patch} options={options} />
      ) : (
        <div className="p-4 font-mono text-[11px] italic text-text-dim">
          diff unavailable for {filePath}
        </div>
      )}
      {active && (
        <AnnotationPopup
          annotation={active.annotation}
          anchorRect={active.rect}
          onReply={onReplyAnnotation}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        />
      )}
    </section>
  );
}

/** Build the popup anchor rect: vertical position from the hovered line, horizontal
 *  extent from pierre's shadow-host element in the light DOM. The line itself lives inside
 *  a horizontally-scrollable code area, so `lineElement.right` can extend past the visible
 *  diff column — using the host's right edge keeps the popup pinned inside the diff. */
function anchorRectFor(lineElement: HTMLElement): DOMRect {
  const root = lineElement.getRootNode();
  const host = root instanceof ShadowRoot ? (root.host as HTMLElement) : lineElement;
  const lineRect = lineElement.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  return new DOMRect(hostRect.left, lineRect.top, hostRect.width, lineRect.height);
}

// --- Pure helpers (testable, no IO) ---

/** Build an O(1) lookup keyed by `${side}:${lineNumber}`. */
function buildLookup(annotations: PrReviewAnnotation[]): Map<AnnotationKey, PrReviewAnnotation> {
  const map = new Map<AnnotationKey, PrReviewAnnotation>();
  for (const a of annotations) {
    const side: AnnotationSide = a.side === "old" ? "deletions" : "additions";
    map.set(toKey(side, a.line), a);
  }
  return map;
}

function toKey(side: AnnotationSide, lineNumber: number): AnnotationKey {
  return `${side}:${lineNumber}`;
}

/** Solid purple wash that replaces pierre's red/green addition/deletion backgrounds. */
const COMMENT_BG = "rgba(168, 85, 247, 0.36)";
/** Slightly stronger tint for the gutter cell so the line number column reads as the same band. */
const COMMENT_GUTTER_BG = "rgba(168, 85, 247, 0.48)";
/** Marker so we can clean prior paints when annotations or visible rows change. */
const PAINTED_ATTR = "data-goodboy-painted";

/** Paint every grid cell of a commented row with inline `!important` styles. Inline styles
 *  beat all `@layer` rules pierre injects, so we don't fight specificity or cascade order.
 *  Re-runs on every `onPostRender` so virtualized re-mounts also get repainted.
 *
 *  Two-pass strategy:
 *    1. Walk every `[data-line]` code cell, decide which annotations it matches by inspecting
 *       `data-line-type` (`change-addition` / `change-deletion` / `context` / `context-expanded`),
 *       `data-line` (new-side number for additions/context, old-side number for deletions in
 *       unified mode; side-local number in split), and `data-alt-line` (the opposite-side
 *       number on context rows). Collect the `data-line-index` of matched rows.
 *    2. Paint every cell that shares one of those `data-line-index` values — covers gutters,
 *       buffers, and the code cell itself in both unified and split layouts.
 *
 *  Works for change AND unchanged context lines, in unified AND split modes. */
function paintCommentRows(root: ShadowRoot | HTMLElement, annotations: PrReviewAnnotation[]): void {
  // Clear previous paints first (rows may have scrolled / annotations may have changed).
  root.querySelectorAll<HTMLElement>(`[${PAINTED_ATTR}]`).forEach((el) => {
    el.style.removeProperty("--diffs-line-bg");
    el.style.removeProperty("background-color");
    el.style.removeProperty("cursor");
    el.removeAttribute(PAINTED_ATTR);
  });

  if (annotations.length === 0) return;

  const wantNew = new Set<number>();
  const wantOld = new Set<number>();
  for (const a of annotations) (a.side === "new" ? wantNew : wantOld).add(a.line);

  // Pass 1: identify matching rows by data-line-index.
  //
  // Per-row side semantics:
  //   - change-addition row contributes ("new", data-line)
  //   - change-deletion row contributes ("old", data-line)
  //   - context / context-expanded rows depend on layout:
  //       split additions side ([data-additions] ancestor)  -> ("new", data-line)
  //       split deletions side ([data-deletions] ancestor)  -> ("old", data-line)
  //       unified (no side wrapper)                          -> ("new", data-line) AND ("old", data-alt-line)
  //
  // Side and axis must agree — do NOT cross-check (e.g. data-alt-line against wantNew),
  // otherwise a context row whose alt-line happens to equal an annotated line on the
  // other side gets a false-positive paint.
  const matchingIndices = new Set<string>();
  root.querySelectorAll<HTMLElement>("[data-line][data-line-type]").forEach((el) => {
    const idx = el.getAttribute("data-line-index");
    const type = el.getAttribute("data-line-type");
    const line = numAttr(el, "data-line");
    const alt = numAttr(el, "data-alt-line");
    if (idx == null || line == null) return;

    let match = false;
    if (type === "change-addition") {
      match = wantNew.has(line);
    } else if (type === "change-deletion") {
      match = wantOld.has(line);
    } else if (type === "context" || type === "context-expanded") {
      const inAdditions = el.closest("[data-additions]") != null;
      const inDeletions = el.closest("[data-deletions]") != null;
      if (inAdditions) match = wantNew.has(line);
      else if (inDeletions) match = wantOld.has(line);
      else match = wantNew.has(line) || (alt != null && wantOld.has(alt));
    }
    if (match) matchingIndices.add(idx);
  });

  // Pass 2: paint every cell sharing those line-indices.
  for (const idx of matchingIndices) {
    root
      .querySelectorAll<HTMLElement>(`[data-line-index="${CSS.escape(idx)}"]`)
      .forEach((el) => {
        const isGutter = el.hasAttribute("data-column-number") || el.hasAttribute("data-gutter-buffer");
        const bg = isGutter ? COMMENT_GUTTER_BG : COMMENT_BG;
        el.style.setProperty("--diffs-line-bg", bg, "important");
        el.style.setProperty("background-color", bg, "important");
        el.style.setProperty("cursor", "help", "important");
        el.setAttribute(PAINTED_ATTR, "");
      });
  }
}

function numAttr(el: Element, name: string): number | null {
  const v = el.getAttribute(name);
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
