/**
 * Single shared EventSource for the whole app. Components subscribe via
 * `useSSE`; the connection auto-opens on first subscriber and auto-closes when
 * the last one unmounts. Reconnects on error with a fixed backoff.
 */

import { useEffect, useRef } from "react";
import type { SSEEvent } from "@dashboard/shared";
import { SSE_RETRY_MS } from "@dashboard/lib/constants";

export type { SSEEvent };

type Listener = (event: SSEEvent) => void;

const listeners = new Set<Listener>();
const EVENT_TYPES: SSEEvent["type"][] = [
  "task_update",
  "stage_update",
  "pr_update",
  "pr_session_update",
  "memory_run_update",
  "session_entry",
];

let es: EventSource | null = null;
let retryTimeout: ReturnType<typeof setTimeout>;

function ensureConnected(): void {
  if (es) return;
  es = new EventSource("/api/events");

  const dispatch = (e: MessageEvent): void => {
    try {
      const data = JSON.parse(e.data) as SSEEvent;
      listeners.forEach((l) => l(data));
    } catch {
      // ignore malformed events
    }
  };

  for (const type of EVENT_TYPES) es.addEventListener(type, dispatch);

  es.onerror = () => {
    es?.close();
    es = null;
    retryTimeout = setTimeout(ensureConnected, SSE_RETRY_MS);
  };
}

function disconnectIfIdle(): void {
  if (listeners.size > 0) return;
  es?.close();
  es = null;
  clearTimeout(retryTimeout);
}

// --- Public API ---

export function useSSE(onEvent: Listener): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;

  useEffect(() => {
    const handler: Listener = (e) => ref.current(e);
    listeners.add(handler);
    ensureConnected();
    return () => {
      listeners.delete(handler);
      disconnectIfIdle();
    };
  }, []);
}

/** Refetch every time an event passes `filter` (defaults to "every event"). */
export function useSSERefresh(
  refetch: () => void,
  filter?: (event: SSEEvent) => boolean,
): void {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useSSE((event) => {
    if (!filterRef.current || filterRef.current(event)) refetchRef.current();
  });
}
