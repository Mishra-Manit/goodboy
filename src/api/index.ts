import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { subscribe } from "../shared/events.js";
import * as queries from "../db/queries.js";
import { listRepos } from "../shared/repos.js";
import type { TaskStatus } from "../shared/types.js";
import { readTaskLogs, readStageEntries } from "../orchestrator/logs.js";

export function createApi(): Hono {
  const app = new Hono();

  app.use("*", cors());

  // --- Tasks ---

  app.get("/api/tasks", async (c) => {
    const status = c.req.query("status") as TaskStatus | undefined;
    const repo = c.req.query("repo");
    const tasks = await queries.listTasks({ status, repo });
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
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const filePath = path.join("artifacts", id, name);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      return c.text(content);
    } catch {
      return c.json({ error: "Artifact not found" }, 404);
    }
  });

  app.post("/api/tasks/:id/retry", async (c) => {
    const { runPipeline } = await import("../orchestrator/index.js");
    const task = await queries.getTask(c.req.param("id"));
    if (!task || task.status !== "failed") {
      return c.json({ error: "Task not found or not failed" }, 400);
    }
    await queries.updateTask(task.id, { status: "queued", error: null });

    // Fire and forget -- pipeline runs in the background
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const noopTelegram = async (_chatId: string, _text: string) => {};
    runPipeline(task.id, noopTelegram).catch(() => {});

    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const { cancelTask } = await import("../orchestrator/index.js");
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return c.json({ error: "Not found" }, 404);

    cancelTask(task.id);
    await queries.updateTask(task.id, { status: "cancelled" });
    return c.json({ ok: true });
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

  // --- SSE ---

  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribe((event) => {
        stream.writeSSE({
          data: JSON.stringify(event),
          event: event.type,
        });
      });

      // Keep alive
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "", event: "ping" });
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
