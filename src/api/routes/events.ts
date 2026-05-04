/** Server-sent event route for dashboard live updates. */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { SSE_PING_INTERVAL_MS } from "../../shared/runtime/config.js";
import { subscribe } from "../../shared/runtime/events.js";

/** Register the live event stream route. */
export function registerEventRoutes(app: Hono): void {
  app.get("/api/events", (c) => streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((event) => {
      stream.writeSSE({ data: JSON.stringify(event), event: event.type }).catch(() => {});
    });
    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "", event: "ping" }).catch(() => {});
    }, SSE_PING_INTERVAL_MS);

    stream.onAbort(() => {
      unsubscribe();
      clearInterval(keepAlive);
    });
    await new Promise(() => {});
  }));
}
