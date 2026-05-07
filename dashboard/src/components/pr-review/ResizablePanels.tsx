/**
 * Three-pane layout with draggable seams between left/center and center/right.
 * Clamps each side to a min/max range and persists sizes to localStorage.
 * Below lg the layout collapses to a single stacked column. Double-click a
 * handle to reset that side to its default. Each side panel can be collapsed
 * via a toggle icon on the handle.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
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
const COLLAPSED_WIDTH = 36;

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
  const [leftCollapsed, setLeftCollapsed] = useState(() => loadCollapsed(`${storageKey}:left-collapsed`));
  const [rightCollapsed, setRightCollapsed] = useState(() => loadCollapsed(`${storageKey}:right-collapsed`));
  const isWide = useMediaQuery(LG_QUERY);

  const containerRef = useRef<HTMLDivElement>(null);

  const toggleLeft = useCallback(() => {
    setLeftCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(`${storageKey}:left-collapsed`, next);
      return next;
    });
  }, [storageKey]);

  const toggleRight = useCallback(() => {
    setRightCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(`${storageKey}:right-collapsed`, next);
      return next;
    });
  }, [storageKey]);

  const effectiveLeftWidth = leftCollapsed ? COLLAPSED_WIDTH : leftWidth;
  const effectiveRightWidth = rightCollapsed ? COLLAPSED_WIDTH : rightWidth;

  const onDragLeft = useCallback(
    (clientX: number) => {
      if (leftCollapsed) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const proposed = clientX - rect.left;
      const maxByCenter = rect.width - effectiveRightWidth - centerMin;
      const next = clamp(proposed, leftBounds.min, Math.min(leftBounds.max, maxByCenter));
      setLeftWidth(next);
    },
    [leftBounds.min, leftBounds.max, effectiveRightWidth, centerMin, leftCollapsed],
  );

  const onDragRight = useCallback(
    (clientX: number) => {
      if (rightCollapsed) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const proposed = rect.right - clientX;
      const maxByCenter = rect.width - effectiveLeftWidth - centerMin;
      const next = clamp(proposed, rightBounds.min, Math.min(rightBounds.max, maxByCenter));
      setRightWidth(next);
    },
    [rightBounds.min, rightBounds.max, effectiveLeftWidth, centerMin, rightCollapsed],
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
      style={isWide ? { gridTemplateColumns: `${effectiveLeftWidth}px 1fr ${effectiveRightWidth}px` } : undefined}
    >
      {/* Left panel */}
      <div className={cn("min-w-0 transition-[width] duration-200", leftCollapsed && "overflow-hidden")}>
        {leftCollapsed ? null : left}
      </div>
      {center}
      {/* Right panel */}
      <div className={cn("min-w-0 transition-[width] duration-200", rightCollapsed && "overflow-hidden")}>
        {rightCollapsed ? null : right}
      </div>
      {isWide && (
        <>
          <Handle
            offsetPx={effectiveLeftWidth}
            side="left"
            collapsed={leftCollapsed}
            onDrag={onDragLeft}
            onCommit={persistLeft}
            onReset={() => setLeftWidth(leftBounds.default)}
            onToggle={toggleLeft}
          />
          <Handle
            offsetPx={effectiveRightWidth}
            side="right"
            collapsed={rightCollapsed}
            onDrag={onDragRight}
            onCommit={persistRight}
            onReset={() => setRightWidth(rightBounds.default)}
            onToggle={toggleRight}
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
  collapsed: boolean;
  onDrag: (clientX: number) => void;
  onCommit: () => void;
  onReset: () => void;
  onToggle: () => void;
}

/** A 1px visual seam with a 9px hit area, overlaid on the grid edge. Toggle button in the center. */
function Handle({ offsetPx, side, collapsed, onDrag, onCommit, onReset, onToggle }: HandleProps) {
  const [active, setActive] = useState(false);
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return;
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
    [onDrag, onCommit, collapsed],
  );

  const positionStyle =
    side === "left"
      ? { left: `${offsetPx - 4}px` }
      : { right: `${offsetPx - 4}px` };

  const ToggleIcon = getToggleIcon(side, collapsed);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={onPointerDown}
      onDoubleClick={collapsed ? undefined : onReset}
      style={positionStyle}
      className={cn(
        "group absolute inset-y-0 z-20 w-[9px] select-none",
        collapsed ? "cursor-default" : "cursor-col-resize",
      )}
    >
      {/* Seam line */}
      <div
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors",
          active ? "bg-accent" : "bg-glass-border group-hover:bg-text-ghost",
        )}
      />
      {/* Toggle button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "absolute left-1/2 top-6 z-30 -translate-x-1/2",
          "flex h-7 w-7 items-center justify-center rounded-md",
          "border border-glass-border bg-bg-hover text-text-dim shadow-sm",
          "transition-all hover:border-accent/40 hover:text-accent hover:shadow-[0_0_8px_rgba(212,160,23,0.15)]",
        )}
        title={collapsed ? `Expand ${side} panel` : `Collapse ${side} panel`}
      >
        <ToggleIcon size={14} />
      </button>
    </div>
  );
}

// --- Helpers ---

function getToggleIcon(side: "left" | "right", collapsed: boolean) {
  if (side === "left") return collapsed ? PanelLeftOpen : PanelLeftClose;
  return collapsed ? PanelRightOpen : PanelRightClose;
}

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

function loadCollapsed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(key) === "true";
  } catch {
    return false;
  }
}

function saveCollapsed(key: string, value: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
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
