/**
 * Hono REST + SSE app composer for the dashboard.
 * Resource-specific routes live under `api/routes/*` to keep this boundary small.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerEventRoutes } from "./routes/events.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerPrSessionRoutes } from "./routes/pr-sessions.js";
import { registerTaskRoutes } from "./routes/tasks.js";

/** Build the Hono app. Returned once and mounted by `src/index.ts`. */
export function createApi(): Hono {
  const app = new Hono();
  app.use("*", cors());

  registerTaskRoutes(app);
  registerMemoryRoutes(app);
  registerPrSessionRoutes(app);
  registerEventRoutes(app);

  return app;
}
