/**
 * Hono REST + SSE routes that back the dashboard. All routes are read-only
 * or management actions (cancel, retry, dismiss); the real work runs in the
 * pipelines. The `/api/events` route fans out SSE messages from
 * `shared/events.ts`.
 */

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { subscribe } from "../shared/events.js";
import * as queries from "../db/repository.js";
import { listRepos, buildPrUrl } from "../shared/repos.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { TASK_STATUSES, TASK_KINDS } from "../shared/types.js";
import type { TaskStatus, TaskKind } from "../shared/types.js";
import {
  readSessionFile,
  taskSessionPath,
  prSessionPath,
} from "../core/pi/session-file.js";
import { STAGE_NAMES } from "../shared/types.js";
import { cancelTask as cancelRunningTask, type SendTelegram } from "../core/stage.js";
import { runPipeline } from "../pipelines/coding/pipeline.js";
import { runQuestion } from "../pipelines/question/pipeline.js";
import { runPrReview } from "../pipelines/pr-review/pipeline.js";
import { dismissTask } from "../core/cleanup.js";

const log = createLogger("api");

const SSE_PING_INTERVAL_MS = 30_000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/;
const ARTIFACT_NAME_PATTERN = /^[\w.-]+$/;

// Dashboard-triggered retries don't have bot access; skip Telegram.
const noopSend: SendTelegram = async () => {};

const PIPELINES: Record<TaskKind, (taskId: string, send: SendTelegram) => Promise<void>> = {
  coding_task: runPipeline,
  codebase_question: runQuestion,
  pr_review: runPrReview,
};

// --- Public API ---

/** Build the Hono app. Returned once and mounted by `src/index.ts`. */
export function createApi(): Hono {
  const app = new Hono();
  app.use("*", cors());

  // --- Tasks ---

  app.get("/api/tasks", async (c) => {
    const tasks = await queries.listTasks({
      status: oneOf(c.req.query("status"), TASK_STATUSES),
      repo: c.req.query("repo"),
      kind: oneOf(c.req.query("kind"), TASK_KINDS),
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
    const stages = await Promise.all(
      STAGE_NAMES.map(async (stage) => ({
        stage,
        entries: await readSessionFile(taskSessionPath(id, stage)),
      })),
    );
    return c.json({ stages: stages.filter((s) => s.entries.length > 0) });
  });

  app.get("/api/tasks/:id/artifacts/:name", async (c) => {
    const { id, name } = c.req.param();
    const filePath = safeArtifactPath(id, name);
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

  app.get("/api/repos", (c) => c.json(listRepos()));

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
    const sessions = await queries.listPrSessions();
    return c.json(sessions.map((s) => ({ ...s, prUrl: buildPrUrl(s.repo, s.prNumber) })));
  });

  app.get("/api/pr-sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = await queries.getPrSession(id);
    if (!session) return notFound(c);
    const runs = await queries.getRunsForPrSession(id);
    return c.json({ ...session, prUrl: buildPrUrl(session.repo, session.prNumber), runs });
  });

  app.get("/api/pr-sessions/:id/session", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);
    const entries = await readSessionFile(prSessionPath(id));
    return c.json({ entries });
  });

  // --- SSE ---

  app.get("/api/events", (c) => streamSSE(c, async (stream) => {
    const unsubscribe = subscribe((event) => {
      stream.writeSSE({ data: JSON.stringify(event), event: event.type }).catch(() => {});
    });
    const keepAlive = setInterval(() => {
      stream.writeSSE({ data: "", event: "ping" }).catch(() => {});
    }, SSE_PING_INTERVAL_MS);

    stream.onAbort(() => {
      unsubscribe();
      clearInterval(keepAlive);
    });
    // Hold the stream open until the client disconnects.
    await new Promise(() => {});
  }));

  return app;
}

// --- Helpers ---

function notFound(c: Context) {
  return c.json({ error: "Not found" }, 404);
}

/** Return `value` if it's one of the allowed literals, else `undefined`. */
function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * Build a path under `artifactsDir/<id>/<name>` after validating both segments.
 * Returns `null` if the id or name is malformed, or the resolved path escapes
 * the artifacts directory.
 */
function safeArtifactPath(id: string, name: string): string | null {
  if (!UUID_PATTERN.test(id)) return null;
  if (!ARTIFACT_NAME_PATTERN.test(name) || name.startsWith(".")) return null;
  const base = path.resolve(config.artifactsDir);
  const full = path.resolve(path.join(base, id, name));
  return full.startsWith(base + path.sep) ? full : null;
}
