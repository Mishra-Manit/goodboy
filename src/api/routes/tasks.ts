/** Task, repository, session, and artifact dashboard routes. */

import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import * as queries from "../../db/repository.js";
import { listRepoSummaries } from "../../shared/domain/repos.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import { emit } from "../../shared/runtime/events.js";
import { createLogger } from "../../shared/runtime/logger.js";
import { TASK_KINDS, TASK_STATUSES } from "../../shared/domain/types.js";
import type { AgentSessionDto, SubagentRunDto, TaskArtifactDto } from "../../shared/contracts/wire.js";
import { isSafeArtifactFilePath } from "../../shared/artifacts/index.js";
import { readSessionFile, taskSessionPath } from "../../core/pi/session-file.js";
import { cancelAndUpdateTask, type SendTelegram } from "../../core/stage.js";
import { dismissTask } from "../../core/cleanup.js";
import { PIPELINES } from "../../pipelines/index.js";
import { buildTaskPrReviewPage } from "../pr-review-page.js";
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

  app.get("/api/tasks/:id/review", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);
    const task = await queries.getTask(id);
    if (!task) return notFound(c);

    const page = await buildTaskPrReviewPage(task);
    if (!page) return notFound(c);
    return c.json(page);
  });

  app.get("/api/tasks/:id/artifacts", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);
    const task = await queries.getTask(id);
    if (!task) return notFound(c);
    const artifacts = await queries.listTaskArtifacts(id);
    return c.json(artifacts.map(toTaskArtifactDto));
  });

  app.get("/api/tasks/:id/artifact-content", async (c) => {
    const id = c.req.param("id");
    const filePath = c.req.query("filePath");
    if (!UUID_PATTERN.test(id) || !filePath || !isSafeArtifactFilePath(filePath)) return notFound(c);
    const task = await queries.getTask(id);
    if (!task) return notFound(c);
    const artifact = await queries.getTaskArtifactByPath(id, filePath);
    if (!artifact) return c.json({ error: "Artifact not found" }, 404);
    if (artifact.contentText !== null) return c.text(artifact.contentText);
    return c.text(`${JSON.stringify(artifact.contentJson, null, 2)}\n`);
  });

  app.get("/api/tasks/:id/session-summary", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);
    const task = await queries.getTask(id);
    if (!task) return notFound(c);
    const sessions = await queries.listAgentSessionsForTask(id);
    const subagents = await queries.listSubagentRunsForAgentSessions(sessions.map((session) => session.id));
    const subagentsBySession = new Map<string, SubagentRunDto[]>();
    for (const run of subagents) {
      subagentsBySession.set(run.parentAgentSessionId, [...(subagentsBySession.get(run.parentAgentSessionId) ?? []), run]);
    }
    return c.json({ sessions: sessions.map((session) => toAgentSessionDto(
      session,
      subagentsBySession.get(session.id) ?? [],
    )) });
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

    const retry = await queries.createRetryTask(task);
    emit({ type: "task_update", taskId: retry.id, status: retry.status, kind: retry.kind });
    PIPELINES[retry.kind](retry.id, noopSend).catch((err) => log.error(`Retry error ${retry.id}`, err));
    return c.json({ ok: true, task: retry }, 201);
  });

  app.post("/api/tasks/:id/cancel", async (c) => {
    const task = await queries.getTask(c.req.param("id"));
    if (!task) return notFound(c);
    await cancelAndUpdateTask(task.id);
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

function toAgentSessionDto(session: queries.AgentSession, subagents: SubagentRunDto[]): AgentSessionDto {
  return {
    id: session.id,
    taskStageId: session.taskStageId,
    prSessionRunId: session.prSessionRunId,
    memoryRunId: session.memoryRunId,
    agentName: session.agentName,
    piSessionId: session.piSessionId,
    model: session.model,
    durationMs: session.durationMs,
    totalTokens: session.totalTokens,
    costUsd: session.costUsd,
    toolCallCount: session.toolCallCount,
    subagents,
  };
}

function toTaskArtifactDto(artifact: queries.TaskArtifact): TaskArtifactDto {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    taskStageId: artifact.taskStageId,
    producerSessionId: artifact.producerSessionId,
    filePath: artifact.filePath,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt.toISOString(),
    updatedAt: artifact.updatedAt.toISOString(),
    contentKind: artifact.contentText !== null ? "text" : "json",
  };
}
