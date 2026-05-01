/**
 * Three-pane layout with draggable seams between left/center and center/right.
 * Clamps each side to a min/max range and persists sizes to localStorage.
 * Below lg the layout collapses to a single stacked column. Double-click a
 * handle to reset that side to its default.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@dashboard/lib/utils";

interface PaneBounds {
  min: number;
  max: number;
  default: number;
}

interface ResizablePanelsProps {
  storageKey: string;
  left: ReactNode;
  center: ReactNode;
  right: ReactNode;
  leftBounds?: PaneBounds;
  rightBounds?: PaneBounds;
  /** Minimum center width below which a drag is ignored. */
  centerMin?: number;
  className?: string;
}

const DEFAULT_LEFT: PaneBounds = { min: 180, max: 400, default: 244 };
const DEFAULT_RIGHT: PaneBounds = { min: 280, max: 600, default: 400 };
const DEFAULT_CENTER_MIN = 360;
const LG_QUERY = "(min-width: 1024px)";

export function ResizablePanels({
  storageKey,
  left,
  center,
  right,
  leftBounds = DEFAULT_LEFT,
  rightBounds = DEFAULT_RIGHT,
  centerMin = DEFAULT_CENTER_MIN,
  className,
}: ResizablePanelsProps) {
  const [leftWidth, setLeftWidth] = useState(() => loadSize(`${storageKey}:left`, leftBounds));
  const [rightWidth, setRightWidth] = useState(() => loadSize(`${storageKey}:right`, rightBounds));
  const isWide = useMediaQuery(LG_QUERY);

  const containerRef = useRef<HTMLDivElement>(null);

  const onDragLeft = useCallback(
    (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const proposed = clientX - rect.left;
      const maxByCenter = rect.width - rightWidth - centerMin;
      const next = clamp(proposed, leftBounds.min, Math.min(leftBounds.max, maxByCenter));
      setLeftWidth(next);
    },
    [leftBounds.min, leftBounds.max, rightWidth, centerMin],
  );

  const onDragRight = useCallback(
    (clientX: number) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const proposed = rect.right - clientX;
      const maxByCenter = rect.width - leftWidth - centerMin;
      const next = clamp(proposed, rightBounds.min, Math.min(rightBounds.max, maxByCenter));
      setRightWidth(next);
    },
    [rightBounds.min, rightBounds.max, leftWidth, centerMin],
  );

  const persistLeft = useCallback(
    () => saveSize(`${storageKey}:left`, leftWidth),
    [storageKey, leftWidth],
  );
  const persistRight = useCallback(
    () => saveSize(`${storageKey}:right`, rightWidth),
    [storageKey, rightWidth],
  );

  return (
    <div
      ref={containerRef}
      className={cn("relative grid grid-cols-1", className)}
      style={isWide ? { gridTemplateColumns: `${leftWidth}px 1fr ${rightWidth}px` } : undefined}
    >
      {left}
      {center}
      {right}
      {isWide && (
        <>
          <Handle
            offsetPx={leftWidth}
            side="left"
            onDrag={onDragLeft}
            onCommit={persistLeft}
            onReset={() => setLeftWidth(leftBounds.default)}
          />
          <Handle
            offsetPx={rightWidth}
            side="right"
            onDrag={onDragRight}
            onCommit={persistRight}
            onReset={() => setRightWidth(rightBounds.default)}
          />
        </>
      )}
    </div>
  );
}

// --- Handle ---

interface HandleProps {
  offsetPx: number;
  side: "left" | "right";
  onDrag: (clientX: number) => void;
  onCommit: () => void;
  onReset: () => void;
}

/** A 1px visual seam with a 9px hit area, overlaid on the grid edge. */
function Handle({ offsetPx, side, onDrag, onCommit, onReset }: HandleProps) {
  const [active, setActive] = useState(false);
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setActive(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      function onMove(ev: PointerEvent) {
        onDrag(ev.clientX);
      }
      function onUp() {
        setActive(false);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        onCommit();
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [onDrag, onCommit],
  );

  const positionStyle =
    side === "left"
      ? { left: `${offsetPx - 4}px` }
      : { right: `${offsetPx - 4}px` };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      style={positionStyle}
      className="group absolute inset-y-0 z-20 w-[9px] cursor-col-resize select-none"
    >
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          active ? "bg-accent" : "bg-glass-border group-hover:bg-text-ghost",
        )}
      />
    </div>
  );
}

// --- Helpers ---

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function loadSize(key: string, bounds: PaneBounds): number {
  if (typeof window === "undefined") return bounds.default;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return bounds.default;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return bounds.default;
    return clamp(parsed, bounds.min, bounds.max);
  } catch {
    return bounds.default;
  }
}

function saveSize(key: string, value: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(Math.round(value)));
  } catch {
    /* ignore quota errors */
  }
}

/** Subscribes to a CSS media query and re-renders on change. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
