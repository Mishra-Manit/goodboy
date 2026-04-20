/**
 * Append-only bucket of pi session entries received over SSE. Pages seed
 * state with the on-disk snapshot, then merge this hook's output to get a
 * live view. De-duping happens at the page (by entry `id`).
 */

import { useRef, useState } from "react";
import { useSSE } from "./use-sse.js";
import type { FileEntry, SSEEvent } from "@dashboard/lib/api";

interface UseLiveSessionOptions {
  /** Accept the event if it belongs to this view; return a bucket key for it. */
  match: (event: SSEEvent) => { key: string; entry: FileEntry } | null;
}

/** Map<key, FileEntry[]>. Each key is caller-defined (e.g. stage name or session id). */
export function useLiveSession({ match }: UseLiveSessionOptions): Map<string, FileEntry[]> {
  const [buckets, setBuckets] = useState<Map<string, FileEntry[]>>(new Map());
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
