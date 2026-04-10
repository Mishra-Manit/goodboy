import type { SSEEvent } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("events");

type Listener = (event: SSEEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emit(event: SSEEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.error("SSE listener threw", err);
    }
  }
}
