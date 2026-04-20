/**
 * Process entry point. Boots the Hono server (API + dashboard static files),
 * the Grammy Telegram bot, and the PR poller, then wires SIGINT/SIGTERM to
 * a single shutdown path.
 */

import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { createTelegramBot } from "./telegram/index.js";
import { createApi } from "./api/index.js";
import { startPrPoller, stopPrPoller } from "./pipelines/pr-session/poller.js";
import type { SendTelegram } from "./core/stage.js";
import { loadEnv } from "./shared/config.js";
import { createLogger } from "./shared/logger.js";

const log = createLogger("main");

async function main(): Promise<void> {
  const env = loadEnv();

  const app = new Hono();
  const api = createApi();
  app.route("/", api);
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));

  // SPA fallback: serve index.html for any non-API route that didn't match a static file
  app.get("*", async (c) => {
    const html = await readFile("./dashboard/dist/index.html", "utf-8");
    return c.html(html);
  });

  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
    log.info(`Server running on http://${env.HOST}:${info.port}`);
  });

  const telegramBot = createTelegramBot();

  // telegramBot.start() blocks forever (Grammy long-polling). Everything that needs
  // to run after the bot is ready must go inside the onStart callback.
  await telegramBot.start({
    onStart: () => {
      log.info("Telegram bot started");

      const sendTelegram: SendTelegram = async (chatId, text) => {
        await telegramBot.api.sendMessage(Number(chatId), text);
      };

      startPrPoller(sendTelegram);

      log.info("Goodboy is running");

      const shutdown = async (): Promise<void> => {
        log.info("Shutting down...");
        stopPrPoller();
        await telegramBot.stop();
        server.close();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    },
  });
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled rejection", reason);
  process.exit(1);
});

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
