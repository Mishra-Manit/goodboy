import type { SSEEvent } from "./types.js";

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
    } catch {
      // swallow errors in listeners
    }
  }
}
