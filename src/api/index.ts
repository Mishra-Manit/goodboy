/**
 * Hono REST + SSE app composer for the dashboard.
 * Resource-specific routes live under `api/routes/*` to keep this boundary small.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerE2ERoutes } from "./routes/e2e.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerPrReviewRoutes } from "./routes/pr-reviews.js";
import { registerPrSessionRoutes } from "./routes/pr-sessions.js";
import { registerReviewAssetRoutes } from "./routes/review-assets.js";
import { registerTaskRoutes } from "./routes/tasks.js";

/** Build the Hono app. Returned once and mounted by `src/index.ts`. */
export function createApi(): Hono {
  const app = new Hono();
  app.use("*", cors());

  registerTaskRoutes(app);
  registerE2ERoutes(app);
  registerMemoryRoutes(app);
  registerPrReviewRoutes(app);
  registerPrSessionRoutes(app);
  registerReviewAssetRoutes(app);
  registerEventRoutes(app);

  return app;
}
