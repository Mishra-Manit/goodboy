/** Floating annotation popup. Anchored to a viewport rect (the line-number's bounding box),
 *  portaled to document.body so it escapes the diff library's shadow DOM. The kind-colored
 *  left stripe + header label distinguish concern / note / goodboy-fix / user-change. */

import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@dashboard/components/Markdown";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { kindStyle } from "./kinds";

interface AnnotationPopupProps {
  annotation: PrReviewAnnotation;
  /** Viewport-relative rect of the anchor element (typically the line number cell). */
  anchorRect: DOMRect;
  onReply: (annotation: PrReviewAnnotation) => void;
  /** Cursor entered the popup — used to cancel the close timer in the parent. */
  onMouseEnter: () => void;
  /** Cursor left the popup — used to schedule close in the parent. */
  onMouseLeave: () => void;
}

const POPUP_WIDTH = 420;
const POPUP_GAP = 6;
const VIEWPORT_PADDING = 16;

interface PopupCoords {
  top: number;
  left: number;
  width: number;
}

export function AnnotationPopup({ annotation, anchorRect, onReply, onMouseEnter, onMouseLeave }: AnnotationPopupProps) {
  const style = kindStyle(annotation.kind);
  const lineLabel = `${annotation.side === "old" ? "−" : "+"}${annotation.line}`;
  const coords = usePopupCoords(anchorRect);

  if (!coords) return null;

  return createPortal(
    <div
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: "fixed", top: coords.top, left: coords.left, width: coords.width }}
      className="z-[1000] animate-fade-up"
    >
      <div
        className={cn(
          "overflow-hidden whitespace-normal rounded-lg border border-l-2 border-glass-border bg-bg-raised/95 shadow-[0_24px_60px_rgba(0,0,0,0.7)] backdrop-blur-md",
          style.border,
        )}
      >
        <header className="flex items-center gap-2 px-4 pt-[12px]">
          <span
            className={cn("h-[6px] w-[6px] rounded-full", style.text.replace("text-", "bg-"))}
            aria-hidden
          />
          <span
            className={cn(
              "font-mono text-[10px] font-semibold uppercase tracking-[0.18em]",
              style.text,
            )}
          >
            {style.label}
          </span>
          <span className="ml-auto truncate font-mono text-[10px] text-text-void">
            {filenameTail(annotation.filePath)}:{lineLabel}
          </span>
        </header>

        <div className="min-w-0 px-4 pb-3 pt-[6px]">
          <h3 className="font-display text-[13px] font-medium leading-snug break-words text-text">
            {annotation.title}
          </h3>
          <Markdown
            content={annotation.body}
            className={cn(
              "mt-1.5 font-body text-[12px] leading-[1.55] text-text-dim break-words",
              "prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-p:break-words",
              "prose-code:rounded prose-code:bg-bg-active prose-code:px-1 prose-code:py-0.5 prose-code:text-[11px] prose-code:break-all",
            )}
          />
        </div>

        <footer className="flex items-center justify-end gap-1 border-t border-glass-border bg-bg/60 px-2 py-[6px]">
          <button
            type="button"
            onClick={() => onReply(annotation)}
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
    </div>,
    document.body,
  );
}

// --- Helpers ---

/** Place the popup beneath the anchor rect, right-aligned to the row's right edge so it
 *  floats over the right side of the diff instead of crowding the line-number gutter on the
 *  left. Clamped to the viewport. Re-runs on resize only; scroll-driven movement is handled
 *  by closing the popup (the parent watches line-leave). */
function usePopupCoords(anchorRect: DOMRect): PopupCoords | null {
  const [coords, setCoords] = useState<PopupCoords | null>(null);

  useLayoutEffect(() => {
    const compute = (): PopupCoords => {
      const width = Math.min(POPUP_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
      // Right-align: popup's right edge sits at the row's right edge.
      const desiredLeft = anchorRect.right - width;
      const left = Math.max(
        VIEWPORT_PADDING,
        Math.min(desiredLeft, window.innerWidth - width - VIEWPORT_PADDING),
      );
      const top = anchorRect.bottom + POPUP_GAP;
      return { top, left, width };
    };
    setCoords(compute());
    const onResize = () => setCoords(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [anchorRect]);

  return coords;
}

function filenameTail(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
