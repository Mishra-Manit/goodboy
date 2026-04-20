/**
 * In-process pub/sub for SSE events. Producers call `emit`; the dashboard's
 * SSE endpoint calls `subscribe` per connection. Listener errors are logged
 * and swallowed so one bad subscriber can't break the fanout.
 */

import type { SSEEvent } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("events");

type Listener = (event: SSEEvent) => void;

const listeners = new Set<Listener>();

/** Subscribe to all events. Returns an unsubscribe function. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Broadcast an event to every subscriber. Listener errors are caught and logged. */
export function emit(event: SSEEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.error("SSE listener threw", err);
    }
  }
}
