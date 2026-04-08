import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { loadEnv } from "../shared/config.js";
import { subscribe } from "../shared/events.js";
import * as queries from "../db/queries.js";
import type { TaskStatus } from "../shared/types.js";

export function createApi(): Hono {
  const app = new Hono();

  app.use("*", cors());

  // Auth middleware
  app.use("/api/*", async (c, next) => {
    const env = loadEnv();
    const apiKey = c.req.header("X-API-Key");
    if (apiKey !== env.API_KEY) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

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
    // TODO: implement log storage/retrieval
    return c.json({ logs: [] });
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
    const task = await queries.getTask(c.req.param("id"));
    if (!task || task.status !== "failed") {
      return c.json({ error: "Task not found or not failed" }, 400);
    }
    await queries.updateTask(task.id, { status: "queued", error: null });
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

  app.get("/api/repos", async (c) => {
    const repos = await queries.listRepos();
    return c.json(repos);
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
