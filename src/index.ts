import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { createBot } from "./bot/index.js";
import { createApi } from "./api/index.js";
import { startPrPoller, stopPrPoller } from "./orchestrator/index.js";
import type { SendTelegram } from "./orchestrator/index.js";
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

  const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    log.info(`Server running on http://${env.HOST}:${info.port}`);
  });

  const bot = createBot();

  // bot.start() blocks forever (Grammy long-polling). Everything that needs
  // to run after the bot is ready must go inside the onStart callback.
  await bot.start({
    onStart: () => {
      log.info("Telegram bot started");

      const sendTelegram: SendTelegram = async (chatId, text) => {
        await bot.api.sendMessage(Number(chatId), text);
      };

      startPrPoller(sendTelegram);

      log.info("Goodboy is running");

      const shutdown = async (): Promise<void> => {
        log.info("Shutting down...");
        stopPrPoller();
        await bot.stop();
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
