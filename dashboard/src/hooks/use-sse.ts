import { useEffect, useRef, useCallback } from "react";

export interface SSEEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Subscribe to the SSE event stream from the backend.
 * Reconnects automatically on disconnect.
 */
export function useSSE(onEvent: (event: SSEEvent) => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimeout: ReturnType<typeof setTimeout>;

    function connect() {
      es = new EventSource("/api/events");

      const handleEvent = (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          onEventRef.current(data);
        } catch {
          // ignore malformed events
        }
      };

      es.addEventListener("task_update", handleEvent);
      es.addEventListener("stage_update", handleEvent);
      es.addEventListener("log", handleEvent);
      es.addEventListener("pr_update", handleEvent);

      es.onerror = () => {
        es?.close();
        retryTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    return () => {
      es?.close();
      clearTimeout(retryTimeout);
    };
  }, []);
}

/**
 * Hook that re-fetches data whenever an SSE event matching the filter arrives.
 */
export function useSSERefresh(
  refetch: () => void,
  filter?: (event: SSEEvent) => boolean
): void {
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  const handler = useCallback(
    (event: SSEEvent) => {
      if (!filter || filter(event)) {
        refetchRef.current();
      }
    },
    [filter]
  );

  useSSE(handler);
}
