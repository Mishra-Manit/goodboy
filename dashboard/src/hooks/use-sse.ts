import { useEffect, useRef } from "react";

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

type Listener = (event: SSEEvent) => void;

const listeners = new Set<Listener>();
let es: EventSource | null = null;
let retryTimeout: ReturnType<typeof setTimeout>;

const EVENT_TYPES = ["task_update", "stage_update", "log", "pr_update"];

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

  for (const type of EVENT_TYPES) {
    es.addEventListener(type, dispatch);
  }

  es.onerror = () => {
    es?.close();
    es = null;
    retryTimeout = setTimeout(ensureConnected, 3000);
  };
}

function disconnect(): void {
  if (listeners.size > 0) return;
  es?.close();
  es = null;
  clearTimeout(retryTimeout);
}

export function useSSE(onEvent: (event: SSEEvent) => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;

  useEffect(() => {
    const handler: Listener = (e) => ref.current(e);
    listeners.add(handler);
    ensureConnected();
    return () => {
      listeners.delete(handler);
      disconnect();
    };
  }, []);
}

export function useSSERefresh(
  refetch: () => void,
  filter?: (event: SSEEvent) => boolean
): void {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useSSE((event) => {
    if (!filterRef.current || filterRef.current(event)) {
      refetchRef.current();
    }
  });
}
