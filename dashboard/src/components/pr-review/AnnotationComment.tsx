/** Inline pin trigger: a thin one-line bar with severity badge and excerpt; reveals a floating
 *  popup card on hover/focus. The popup is portaled to document.body so it escapes the
 *  diff library's per-row stacking contexts and always sits on top. */

import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Markdown } from "@dashboard/components/Markdown";
import { cn } from "@dashboard/lib/utils";
import type { PrReviewAnnotation } from "@dashboard/shared";
import { kindStyle } from "./kinds";

interface AnnotationCommentProps {
  annotation: PrReviewAnnotation;
  index: number;
  onReply: (annotation: PrReviewAnnotation) => void;
}

const POPUP_WIDTH = 400;
const POPUP_GAP = 2;
const VIEWPORT_PADDING = 16;

export function AnnotationComment({ annotation, index, onReply }: AnnotationCommentProps) {
  const style = kindStyle(annotation.kind);
  const lineLabel = `${annotation.side === "old" ? "−" : "+"}${annotation.line}`;
  const triggerRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const coords = usePopupCoords(triggerRef, open);

  return (
    <div
      ref={triggerRef}
      className="relative whitespace-normal px-3 py-1"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        className="flex w-full items-center gap-[10px] rounded-md border border-glass-border bg-bg-raised/60 px-[10px] py-[6px] text-left transition-colors hover:border-glass-hover focus:border-accent-dim focus:outline-none"
      >
        <span
          className={cn(
            "flex h-[16px] min-w-[16px] items-center justify-center rounded-full px-1 font-mono text-[10px] font-semibold tabular-nums text-bg",
            style.text.replace("text-", "bg-"),
          )}
        >
          {index}
        </span>
        <span
          className={cn(
            "font-mono text-[10px] font-semibold uppercase tracking-[0.14em]",
            style.text,
          )}
        >
          {style.label}
        </span>
        <span className="truncate font-body text-[12px] text-text-dim">
          {annotation.title}
        </span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-text-void">
          {lineLabel}
        </span>
      </button>

      {open && coords &&
        createPortal(
          <AnnotationPopup
            annotation={annotation}
            onReply={onReply}
            coords={coords}
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          />,
          document.body,
        )}
    </div>
  );
}

// --- Popup ---

interface PopupCoords {
  top: number;
  left: number;
  width: number;
}

interface AnnotationPopupProps {
  annotation: PrReviewAnnotation;
  onReply: (annotation: PrReviewAnnotation) => void;
  coords: PopupCoords;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

function AnnotationPopup({ annotation, onReply, coords, onMouseEnter, onMouseLeave }: AnnotationPopupProps) {
  const style = kindStyle(annotation.kind);
  const lineLabel = `${annotation.side === "old" ? "−" : "+"}${annotation.line}`;

  return (
    <div
      role="tooltip"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ position: "fixed", top: coords.top, left: coords.left, width: coords.width }}
      className="z-[1000] animate-fade-in"
    >
      <div className="overflow-hidden whitespace-normal rounded-lg border border-glass-border bg-bg shadow-[0_18px_40px_rgba(0,0,0,0.6)]">
        <header className="flex items-center gap-2 px-4 pt-[12px]">
          <span
            className={cn(
              "font-mono text-[10px] font-semibold uppercase tracking-[0.16em]",
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

        <footer className="flex items-center justify-end gap-1 border-t border-glass-border bg-bg-raised/40 px-2 py-[6px]">
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
    </div>
  );
}

// --- Helpers ---

/** Compute popup viewport coords from the trigger's bounding rect; tracks scroll/resize while open. */
function usePopupCoords(
  triggerRef: React.RefObject<HTMLDivElement | null>,
  open: boolean,
): PopupCoords | null {
  const [coords, setCoords] = useState<PopupCoords | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    const el = triggerRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      const width = Math.min(POPUP_WIDTH, window.innerWidth - VIEWPORT_PADDING * 2);
      const desiredLeft = r.right - width;
      const left = Math.max(VIEWPORT_PADDING, Math.min(desiredLeft, window.innerWidth - width - VIEWPORT_PADDING));
      const top = r.bottom + POPUP_GAP;
      setCoords({ top, left, width });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, triggerRef]);

  return coords;
}

function filenameTail(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}
