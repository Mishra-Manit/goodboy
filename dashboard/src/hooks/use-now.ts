/**
 * Tick hook that forces a re-render on a fixed interval so pure time
 * formatters (timeAgo) stay live without embedding their own timers.
 */

import { useEffect, useState } from "react";
import { NOW_TICK_MS } from "@dashboard/lib/constants";

/** Periodically-updated `Date.now()` snapshot. */
export function useNow(intervalMs: number = NOW_TICK_MS): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
