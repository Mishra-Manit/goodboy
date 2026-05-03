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
import { findOrphanedMemoryDirs, cleanupStaleMemoryLocks } from "./core/memory/index.js";
import { startArtifactsSweep, stopArtifactsSweep } from "./core/artifacts-cleanup.js";
import { pruneWorktrees } from "./core/git/worktree.js";
import { listRepos, listRepoNames } from "./shared/repos.js";
import { reapRunningRows } from "./db/repository.js";
const log = createLogger("main");

async function main(): Promise<void> {
  initObservability();
  const env = loadEnv();

  // Sweep stale worktree registry entries across all registered repos so
  // deleted memory checkouts don't linger and block future `worktree add`.
  for (const repo of listRepos()) {
    await pruneWorktrees(repo.localPath);
  }

  // Release memory `.lock` files left over from a previous unclean shutdown.
  // After a restart every previously-recorded pid is dead, so any lock whose
  // holder pid no longer exists (or whose timestamp is older than the stale
  // threshold, or that is outright corrupt) is swept here. Fresh locks held
  // by another live goodboy process on the same host are left alone.
  const staleLocks = await cleanupStaleMemoryLocks(listRepoNames());
  if (staleLocks.length > 0) {
    log.info(`Cleaned ${staleLocks.length} stale memory lock(s) on startup`, staleLocks);
    for (const lock of staleLocks) {
      emitStartupEvent("goodboy.memory.lock_cleared", {
        "goodboy.memory.repo": lock.repo,
        "goodboy.memory.previousTaskId": lock.previousTaskId ?? "",
        "goodboy.memory.reason": lock.reason,
      });
    }
  }

  // Reconcile DB rows still marked `running` from a previous unclean
  // shutdown. Symmetric with the memory-lock sweep above: lock files
  // recover on-disk state, this recovers DB state. Without it the
  // dashboard would show an orphaned task/stage as "running" forever.
  const reaped = await reapRunningRows();
  if (reaped.tasks.length || reaped.stages.length || reaped.memoryRuns.length) {
    log.info(
      `Reaped orphan running rows on startup: ${reaped.tasks.length} task(s), ${reaped.stages.length} stage(s), ${reaped.memoryRuns.length} memory run(s)`,
    );
    for (const t of reaped.tasks) {
      emitStartupEvent("goodboy.startup.task_reaped", {
        "goodboy.task.id": t.id,
        "goodboy.task.repo": t.repo,
      });
    }
    for (const s of reaped.stages) {
      emitStartupEvent("goodboy.startup.stage_reaped", {
        "goodboy.stage.id": s.id,
        "goodboy.task.id": s.taskId,
        "goodboy.stage.name": s.stage,
      });
    }
    for (const m of reaped.memoryRuns) {
      emitStartupEvent("goodboy.startup.memory_run_reaped", {
        "goodboy.memory.runId": m.id,
        "goodboy.memory.repo": m.repo,
        "goodboy.memory.kind": m.kind,
      });
    }
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
  const spaIndexHtml = await readFile("./dashboard/dist/index.html", "utf-8");
  app.route("/", api);
  app.use("/*", serveStatic({ root: "./dashboard/dist" }));

  // SPA fallback: serve cached index.html for any non-API route that didn't match a static file.
  app.get("*", (c) => c.html(spaIndexHtml));

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
      startArtifactsSweep();

      log.info("Goodboy is running");

      const shutdown = async (): Promise<void> => {
        log.info("Shutting down...");
        stopPrPoller();
        stopArtifactsSweep();
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
