/** Task, repository, session, and artifact dashboard routes. */

import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import * as queries from "../../db/repository.js";
import { listRepoSummaries } from "../../shared/domain/repos.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import { createLogger } from "../../shared/runtime/logger.js";
import { TASK_KINDS, TASK_STATUSES } from "../../shared/domain/types.js";
import { readSessionFile, taskSessionPath } from "../../core/pi/session-file.js";
import { cancelTask as cancelRunningTask, type SendTelegram } from "../../core/stage.js";
import { dismissTask } from "../../core/cleanup.js";
import { PIPELINES } from "../../pipelines/index.js";
import {
  dedupeStageSessionRows,
  notFound,
  parseEnumQuery,
  safeTaskArtifactPath,
  UUID_PATTERN,
} from "../http.js";

const log = createLogger("api-tasks");
const taskStatusQuerySchema = z.enum(TASK_STATUSES);
const taskKindQuerySchema = z.enum(TASK_KINDS);

// Dashboard-triggered retries don't have bot access; skip Telegram.
const noopSend: SendTelegram = async () => {};

/** Register task and repo routes. */
export function registerTaskRoutes(app: Hono): void {
  app.get("/api/tasks", async (c) => {
    const tasks = await queries.listTasks({
      status: parseEnumQuery(taskStatusQuerySchema, c.req.query("status")),
      repo: c.req.query("repo"),
      kind: parseEnumQuery(taskKindQuerySchema, c.req.query("kind")),
    });
    return c.json(tasks);
  });

  app.get("/api/tasks/:id", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return notFound(c);
    const stages = await queries.getStagesForTask(task.id);
    return c.json({ ...task, stages });
  });

  app.get("/api/tasks/:id/session", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);
    const task = await queries.getTask(id);
    if (!task) return notFound(c);
    const rows = dedupeStageSessionRows(await queries.getStagesForTask(id));
    const stages = await Promise.all(
      rows.map(async (row) => ({
        stage: row.stage,
        variant: row.variant,
        entries: await readSessionFile(taskSessionPath(id, row.stage, row.variant ?? undefined)),
      })),
    );
    return c.json({ stages: stages.filter((stage) => stage.entries.length > 0) });
  });

  app.get("/api/tasks/:id/artifacts/:name", async (c) => {
    const { id, name } = c.req.param();
    const filePath = safeTaskArtifactPath(id, name);
    if (!filePath) return notFound(c);
    try {
      return c.text(await readFile(filePath, "utf-8"));
    } catch {
      return c.json({ error: "Artifact not found" }, 404);
    }
  });

  app.post("/api/tasks/:id/retry", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return notFound(c);
    if (task.status !== "failed") return c.json({ error: "Task is not in failed state" }, 409);

    await queries.updateTask(task.id, { status: "queued", error: null });
    PIPELINES[task.kind](task.id, noopSend).catch((err) => log.error(`Retry error ${task.id}`, err));
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return notFound(c);
    await cancelRunningTask(task.id);
    await queries.updateTask(task.id, { status: "cancelled" });
    return c.json({ ok: true });
  });

  app.post("/api/tasks/:id/dismiss", async (c) => {
    try {
      await dismissTask(c.req.param("id"));
      return c.json({ ok: true });
    } catch (err) {
      const message = toErrorMessage(err);
      if (message.includes("not found")) return c.json({ error: message }, 404);
      if (message.includes("Cannot dismiss")) return c.json({ error: message }, 409);
      log.error(`Dismiss error for ${c.req.param("id")}`, err);
      return c.json({ error: message }, 500);
    }
  });

  app.get("/api/repos", (c) => c.json(listRepoSummaries()));
}
