/**
 * SSE log bucketer. The caller supplies a `match` fn that picks the events
 * it cares about and returns a `{ key, entry }` pair; the hook keeps an
 * append-only Map so pages can merge live with on-disk logs.
 */

import { useRef, useState } from "react";
import { useSSE, type SSEEvent } from "./use-sse.js";
import type { LogEntry } from "@dashboard/lib/api";

interface UseLiveLogsOptions {
  match: (event: SSEEvent) => { key: string; entry: LogEntry } | null;
}

export function useLiveLogs({ match }: UseLiveLogsOptions): Map<string, LogEntry[]> {
  const [buckets, setBuckets] = useState<Map<string, LogEntry[]>>(new Map());
  const matchRef = useRef(match);
  matchRef.current = match;

  useSSE((event) => {
    const hit = matchRef.current(event);
    if (!hit) return;
    setBuckets((prev) => {
      const next = new Map(prev);
      const existing = next.get(hit.key) ?? [];
      next.set(hit.key, [...existing, hit.entry]);
      return next;
    });
  });

  return buckets;
}
