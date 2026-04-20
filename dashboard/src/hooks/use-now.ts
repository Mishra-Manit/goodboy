/**
 * Tick hook that forces a re-render on a fixed interval so pure time
 * formatters (timeAgo) stay live without embedding their own timers.
 */

import { useEffect, useState } from "react";

const DEFAULT_INTERVAL_MS = 15_000;

/** Returns a periodically-updated Date.now() snapshot. */
export function useNow(intervalMs: number = DEFAULT_INTERVAL_MS): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
