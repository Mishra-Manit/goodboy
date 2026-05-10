/** Hide on downward scroll past a small threshold; reveal on any upward scroll. */

import { useCallback, useEffect, useRef, useState } from "react";

interface HideOnScrollResult {
  hidden: boolean;
  setHidden: (v: boolean) => void;
}

export function useHideOnScrollDown(threshold = 24): HideOnScrollResult {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let lastY = window.scrollY;
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - lastY;
        if (y < threshold) setHidden(false);
        else if (delta > 4) setHidden(true);
        else if (delta < -4) setHidden(false);
        lastY = y;
        ticking = false;
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return { hidden, setHidden };
}

/** Attach to any scrollable element to drive nav hide/show. Returns a callback ref. */
export function useHideNavOnContainerScroll(
  setHidden: (v: boolean) => void,
  threshold = 24,
): (node: HTMLElement | null) => void {
  const lastY = useRef(0);
  const ticking = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);

  const callbackRef = useCallback(
    (node: HTMLElement | null) => {
      // Detach from previous element
      if (cleanupRef.current) {
        cleanupRef.current();
        cleanupRef.current = null;
      }

      if (!node) return;

      function onScroll() {
        if (ticking.current) return;
        ticking.current = true;
        requestAnimationFrame(() => {
          const y = node!.scrollTop;
          const delta = y - lastY.current;
          if (y < threshold) setHidden(false);
          else if (delta > 4) setHidden(true);
          else if (delta < -4) setHidden(false);
          lastY.current = y;
          ticking.current = false;
        });
      }

      node.addEventListener("scroll", onScroll, { passive: true });
      cleanupRef.current = () => node.removeEventListener("scroll", onScroll);
    },
    [setHidden, threshold],
  );

  return callbackRef;
}
