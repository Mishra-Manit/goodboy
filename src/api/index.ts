import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { subscribe } from "../shared/events.js";
import * as queries from "../db/queries.js";
import { listRepos } from "../shared/repos.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { TASK_STATUSES, TASK_KINDS } from "../shared/types.js";
import type { TaskStatus, TaskKind } from "../shared/types.js";
import { readTaskLogs } from "../orchestrator/logs.js";
import { runPipeline, runQuestion, runPrReview, cancelTask as cancelRunningTask, dismissTask } from "../orchestrator/index.js";

const log = createLogger("api");

export function createApi(): Hono {
  const app = new Hono();

  app.use("*", cors());

  // --- Tasks ---

  app.get("/api/tasks", async (c) => {
    const rawStatus = c.req.query("status");
    const status = rawStatus && TASK_STATUSES.includes(rawStatus as TaskStatus)
      ? (rawStatus as TaskStatus)
      : undefined;
    const repo = c.req.query("repo");
    const rawKind = c.req.query("kind");
    const kind = rawKind && TASK_KINDS.includes(rawKind as TaskKind)
      ? (rawKind as TaskKind)
      : undefined;
    const tasks = await queries.listTasks({ status, repo, kind });
    return c.json(tasks);
  });

  app.get("/api/tasks/:id", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);

    const stages = await queries.getStagesForTask(task.id);
    return c.json({ ...task, stages });
  });

  app.get("/api/tasks/:id/logs", async (c) => {
    const logs = await readTaskLogs(c.req.param("id"));
    return c.json({ logs });
  });

  app.get("/api/tasks/:id/artifacts/:name", async (c) => {
    const { id, name } = c.req.param();

    // Validate inputs to prevent path traversal
    if (!/^[0-9a-f-]{36}$/.test(id)) return c.json({ error: "Not found" }, 404);
    if (!/^[\w.-]+$/.test(name) || name.startsWith(".")) return c.json({ error: "Not found" }, 404);

    // Verify path stays within artifacts/
    const base = path.resolve(config.artifactsDir);
    const filePath = path.resolve(path.join(base, id, name));
    if (!filePath.startsWith(base + path.sep)) return c.json({ error: "Not found" }, 404);

    try {
      const content = await readFile(filePath, "utf-8");
      return c.text(content);
    } catch {
      return c.json({ error: "Artifact not found" }, 404);
    }
  });

  app.post("/api/tasks/:id/retry", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);
    if (task.status !== "failed") return c.json({ error: "Task is not in failed state" }, 409);

    await queries.updateTask(task.id, { status: "queued", error: null });
    // Dashboard-triggered retries don't have access to the bot instance,
    // so Telegram notifications are skipped. The user is watching the dashboard.
    const noopSend = async (_chatId: string, _text: string): Promise<void> => {};

    switch (task.kind) {
      case "coding_task":
        runPipeline(task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
        break;
      case "codebase_question":
        runQuestion(task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
        break;
      case "pr_review":
        runPrReview(task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
        break;
    }
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);
    cancelRunningTask(task.id);
    await queries.updateTask(task.id, { status: "cancelled" });
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/dismiss", async (c) => {
    try {
      await dismissTask(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) return c.json({ error: message }, 404);
      if (message.includes("Cannot dismiss")) return c.json({ error: message }, 409);
      log.error(`Dismiss error for ${c.req.param("id")}`, err);
      return c.json({ error: message }, 500);
    }
  });

  // --- Repos ---

  app.get("/api/repos", (c) => {
    return c.json(listRepos());
  });

  // --- PRs ---

  app.get("/api/prs", async (c) => {
    const tasks = await queries.listTasks();
    const prs = tasks
      .filter((t) => t.prUrl)
      .map((t) => ({
        taskId: t.id,
        repo: t.repo,
        prUrl: t.prUrl,
        prNumber: t.prNumber,
        status: t.status,
      }));
    return c.json(prs);
  });

  // --- PR Sessions ---

  app.get("/api/pr-sessions", async (c) => {
    return c.json(await queries.listPrSessions());
  });

  // --- SSE ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe((event) => {
        stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
        }).catch(() => {});
      });

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "", event: "ping" }).catch(() => {});
      }, 30_000);

      stream.onAbort(() => {
        unsubscribe();
        clearInterval(keepAlive);
      });

      // Block until client disconnects
      await new Promise(() => {});
    });
  });

  return app;
}
