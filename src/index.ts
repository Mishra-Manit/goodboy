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
import { initObservability, shutdownObservability, emitStartupEvent } from "./observability/index.js";
import { findOrphanedMemoryDirs } from "./core/memory/index.js";
import { pruneWorktrees } from "./core/git/worktree.js";
import { listRepos, listRepoNames } from "./shared/repos.js";
const log = createLogger("main");

async function main(): Promise<void> {
  initObservability();
  const env = loadEnv();

  // Sweep stale worktree registry entries across all registered repos so
  // deleted memory checkouts don't linger and block future `worktree add`.
  for (const repo of listRepos()) {
    await pruneWorktrees(repo.localPath);
  }

  // Warn (but do not delete) memory dirs whose repo is no longer registered.
  const orphans = await findOrphanedMemoryDirs(listRepoNames());
  for (const o of orphans) {
    log.warn(
      `Orphaned memory directory: ${o.path} (repo "${o.repo}" not in REGISTERED_REPOS). Leaving on disk.`,
    );
    emitStartupEvent("goodboy.memory.orphan_detected", {
      "goodboy.memory.repo": o.repo,
      "goodboy.memory.path": o.path,
    });
  }

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
        await shutdownObservability();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
    },
  });
}

process.on("unhandledRejection", async (reason) => {
  log.error("Unhandled rejection", reason);
  await shutdownObservability().catch(() => {});
  process.exit(1);
});

main().catch((err) => {
  log.error("Fatal error", err);
  process.exit(1);
});
