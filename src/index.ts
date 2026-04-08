import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { createBot } from "./bot/index.js";
import { createApi } from "./api/index.js";
import { createWebhookHandler } from "./webhooks/github.js";
import { loadEnv } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";

const log = createLogger("main");

async function main() {
  const env = loadEnv();

  // Hono app combining API + webhooks + static dashboard
  const app = new Hono();

  // Mount API routes
  const api = createApi();
  app.route("/", api);

  // Mount webhook handler
  const webhooks = createWebhookHandler();
  app.route("/", webhooks);

  // Serve dashboard static files
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));

  // Start HTTP server
  const port = Number(env.PORT);
  serve({ fetch: app.fetch, port }, (info) => {
    log.info(`Server running on http://${env.HOST}:${info.port}`);
  });

  // Start Telegram bot
  const bot = createBot();
  bot.start({
    onStart: () => {
      log.info("Telegram bot started");
    },
  });

  log.info("Goodboy is running");

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...");
    bot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
