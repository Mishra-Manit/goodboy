/**
 * Three-pane layout with draggable seams between left/center and center/right.
 * Clamps each side to a min/max range and persists sizes to localStorage.
 * Below lg the layout collapses to a single stacked column. Double-click a
 * handle to reset that side to its default. Each side panel can be collapsed
 * via a toggle icon integrated into the panel header.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@dashboard/lib/utils";
import { useMediaQuery } from "@dashboard/hooks/use-media-query";

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
  leftLabel?: string;
  rightLabel?: string;
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
  leftLabel = "Files",
  rightLabel = "Thread",
  leftBounds = DEFAULT_LEFT,
  rightBounds = DEFAULT_RIGHT,
  centerMin = DEFAULT_CENTER_MIN,
  className,
}: ResizablePanelsProps) {
  const [leftWidth, setLeftWidth] = useState(() => loadSize(`${storageKey}:left`, leftBounds));
  const [rightWidth, setRightWidth] = useState(() => loadSize(`${storageKey}:right`, rightBounds));
  const [leftCollapsed, setLeftCollapsed] = useState(() => loadCollapsed(`${storageKey}:left-collapsed`));
  const [rightCollapsed, setRightCollapsed] = useState(() => loadCollapsed(`${storageKey}:right-collapsed`));
  const [isTransitioning, setIsTransitioning] = useState(false);
  const transitionTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const isWide = useMediaQuery(LG_QUERY);

  const containerRef = useRef<HTMLDivElement>(null);

  const startTransition = useCallback(() => {
    setIsTransitioning(true);
    if (transitionTimer.current) clearTimeout(transitionTimer.current);
    transitionTimer.current = setTimeout(() => setIsTransitioning(false), 300);
  }, []);

  const toggleLeft = useCallback(() => {
    startTransition();
    setLeftCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(`${storageKey}:left-collapsed`, next);
      return next;
    });
  }, [storageKey, startTransition]);

  const toggleRight = useCallback(() => {
    startTransition();
    setRightCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(`${storageKey}:right-collapsed`, next);
      return next;
    });
  }, [storageKey, startTransition]);

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
      className={cn("relative grid grid-cols-1 overflow-hidden", className)}
      style={isWide ? {
        gridTemplateColumns: `${effectiveLeftWidth}px 1fr ${effectiveRightWidth}px`,
        ...(isTransitioning ? { transition: "grid-template-columns 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94)" } : {}),
      } : undefined}
    >
      {/* Left panel */}
      <div className="min-h-0 min-w-0 overflow-hidden">
        <PanelShell
          side="left"
          label={leftLabel}
          collapsed={leftCollapsed}
          onToggle={toggleLeft}
        >
          <AnimatePresence mode="wait">
            {!leftCollapsed && (
              <motion.div
                key="left-panel"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -12 }}
                transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="flex-1 min-h-0 overflow-y-auto"
              >
                {left}
              </motion.div>
            )}
          </AnimatePresence>
        </PanelShell>
      </div>
      <div className="min-h-0 min-w-0 overflow-hidden">{center}</div>
      {/* Right panel */}
      <div className="min-h-0 min-w-0 overflow-hidden">
        <PanelShell
          side="right"
          label={rightLabel}
          collapsed={rightCollapsed}
          onToggle={toggleRight}
        >
          <AnimatePresence mode="wait">
            {!rightCollapsed && (
              <motion.div
                key="right-panel"
                initial={{ opacity: 0, x: 12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ duration: 0.2, ease: [0.25, 0.46, 0.45, 0.94] }}
                className="flex-1 min-h-0 overflow-hidden"
              >
                {right}
              </motion.div>
            )}
          </AnimatePresence>
        </PanelShell>
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
          />
          <Handle
            offsetPx={effectiveRightWidth}
            side="right"
            collapsed={rightCollapsed}
            onDrag={onDragRight}
            onCommit={persistRight}
            onReset={() => setRightWidth(rightBounds.default)}
          />
        </>
      )}
    </div>
  );
}

// --- Panel Shell ---

interface PanelShellProps {
  side: "left" | "right";
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/** Unified panel wrapper with header containing label + collapse toggle. */
function PanelShell({ side, label, collapsed, onToggle, children }: PanelShellProps) {
  const ToggleIcon = getToggleIcon(side, collapsed);

  return (
    <div className="flex h-full flex-col">
      {/* Panel header */}
      <header
        className={cn(
          "flex items-center border-b border-glass-border px-4 py-3",
          collapsed && "justify-center px-1",
        )}
      >
        {!collapsed && (
          <h2 className="min-w-0 truncate font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-text-ghost">
            {label}
          </h2>
        )}
        <motion.button
          type="button"
          onClick={onToggle}
          whileHover={{ scale: 1.1 }}
          whileTap={{ scale: 0.9 }}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded-md",
            "text-text-ghost transition-all hover:text-accent hover:bg-accent-ghost",
            !collapsed && "ml-auto",
          )}
          title={collapsed ? `Expand ${side} panel` : `Collapse ${side} panel`}
        >
          <ToggleIcon size={13} />
        </motion.button>
      </header>
      <div className="flex flex-1 min-h-0 flex-col">
        {children}
      </div>
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
}

/** A 1px visual seam with a 9px hit area, overlaid on the grid edge. */
function Handle({ offsetPx, side, collapsed, onDrag, onCommit, onReset }: HandleProps) {
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

