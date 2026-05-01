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
import { z } from "zod";
import { subscribe } from "../shared/events.js";
import * as queries from "../db/repository.js";
import { listRepoSummaries, buildPrUrl, getRepo } from "../shared/repos.js";
import {
  memoryStatus,
  currentHeadSha,
  tryAcquireLock,
  releaseLock,
} from "../core/memory/index.js";
import { cleanupTestMemoryRuns } from "../core/memory/cleanup.js";
import { deleteRepoMemoryArtifacts } from "../core/memory/delete.js";
import { config } from "../shared/config.js";
import { createLogger } from "../shared/logger.js";
import { toErrorMessage } from "../shared/errors.js";
import {
  TASK_STATUSES,
  TASK_KINDS,
  MEMORY_RUN_KINDS,
  PR_SESSION_WATCH_STATUSES,
} from "../shared/types.js";
import {
  readSessionFile,
  taskSessionPath,
  prSessionPath,
  watchSessionFile,
} from "../core/pi/session-file.js";
import { cancelTask as cancelRunningTask, type SendTelegram } from "../core/stage.js";
import { PIPELINES } from "../pipelines/index.js";
import { dismissTask } from "../core/cleanup.js";
import { safeArtifactPath } from "./helpers.js";
import { taskArtifactsDir } from "../shared/artifacts.js";
import { prReviewArtifactPaths } from "../pipelines/pr-review/artifacts.js";
import { readReviewArtifact } from "../pipelines/pr-review/read-review.js";
import { refreshReviewArtifacts } from "../pipelines/pr-session/refresh-review.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  reviewChatRequestSchema,
  type PrReviewPageDto,
  type ReviewChatMessage,
  type ReviewChatResponse,
  type ReviewChatPostResponse,
} from "../shared/pr-review.js";
import { extractReviewChatMessages } from "../pipelines/pr-session/review-chat/index.js";
import {
  runReviewChatTurn,
  ReviewChatBusyError,
  ReviewChatNotFoundError,
  ReviewChatUnavailableError,
} from "../pipelines/pr-session/session.js";

const log = createLogger("api");

const SSE_PING_INTERVAL_MS = 30_000;
const MEMORY_RUN_STATUS_POLL_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f-]{36}$/;
const taskStatusQuerySchema = z.enum(TASK_STATUSES);
const taskKindQuerySchema = z.enum(TASK_KINDS);
const memoryRunKindQuerySchema = z.enum(MEMORY_RUN_KINDS);
const prSessionWatchBodySchema = z.object({
  watchStatus: z.enum(PR_SESSION_WATCH_STATUSES),
});

// Dashboard-triggered retries don't have bot access; skip Telegram.
const noopSend: SendTelegram = async () => {};

// --- Public API ---

/** Build the Hono app. Returned once and mounted by `src/index.ts`. */
export function createApi(): Hono {
  const app = new Hono();
  app.use("*", cors());

  // --- Tasks ---

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
    return c.json({ stages: stages.filter((s) => s.entries.length > 0) });
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

  // --- Repos ---

  app.get("/api/repos", (c) => c.json(listRepoSummaries()));

  // --- Memory ---

  app.get("/api/memory/status/:repo", async (c) => {
    const name = c.req.param("repo");
    const repo = getRepo(name);
    if (!repo) return c.json({ error: "unknown repo" }, 404);

    const { state, fileCount, totalBytes } = await memoryStatus(name);
    if (!state) {
      return c.json({
        repo: name, status: "missing",
        lastIndexedSha: null, lastIndexedAt: null,
        fileCount: 0, totalBytes: 0, zones: [],
      });
    }

    let live: string | null = null;
    try { live = await currentHeadSha(repo.localPath); } catch { /* unreachable */ }

    return c.json({
      repo: name,
      status: live && live === state.lastIndexedSha ? "fresh" : "stale",
      lastIndexedSha: state.lastIndexedSha,
      lastIndexedAt: state.lastIndexedAt,
      fileCount, totalBytes,
      zones: state.zones.map((z) => ({ name: z.name, path: z.path, summary: z.summary })),
    });
  });

  app.get("/api/memory/runs", async (c) => {
    const repo = c.req.query("repo");
    const limit = parseLimit(c.req.query("limit"));
    const includeTests = c.req.query("includeTests") !== "false";
    const includeInactive = c.req.query("includeInactive") === "true";
    const kind = parseEnumQuery(memoryRunKindQuerySchema, c.req.query("kind"));

    const runs = await queries.listMemoryRuns({ repo, limit, includeTests, includeInactive, kind });
    return c.json(runs);
  });

  app.get("/api/memory/runs/:id", async (c) => {
    const run = await queries.getMemoryRun(c.req.param("id"));
    if (!run) return notFound(c);
    return c.json(run);
  });

  app.get("/api/memory/runs/:id/session", async (c) => {
    const run = await queries.getMemoryRun(c.req.param("id"));
    if (!run) return notFound(c);
    if (!run.sessionPath) return c.json({ entries: [] });

    try {
      const entries = await readSessionFile(run.sessionPath);
      return c.json({ entries });
    } catch (err) {
      log.warn(`Failed to read session ${run.sessionPath}`, err);
      return c.json({ entries: [] });
    }
  });

  app.get("/api/memory/runs/:id/events", async (c) => {
    const run = await queries.getMemoryRun(c.req.param("id"));
    if (!run) return notFound(c);

    return streamSSE(c, async (stream) => {
      let currentStatus = run.status;
      const stopWatch = run.sessionPath
        ? watchSessionFile(run.sessionPath, (entry) => {
            stream.writeSSE({ data: JSON.stringify({ entry }), event: "session_entry" }).catch(() => {});
          })
        : () => {};
      const keepAlive = setInterval(() => {
        stream.writeSSE({ data: "", event: "ping" }).catch(() => {});
      }, SSE_PING_INTERVAL_MS);
      const statusPoll = setInterval(() => {
        void queries.getMemoryRun(run.id).then((latest) => {
          if (!latest) return;
          if (latest.status === currentStatus) return;
          currentStatus = latest.status;
          stream.writeSSE({
            data: JSON.stringify({ status: latest.status }),
            event: "memory_run_update",
          }).catch(() => {});
          if (latest.status !== "running") clearInterval(statusPoll);
        }).catch(() => {});
      }, MEMORY_RUN_STATUS_POLL_MS);

      stream.onAbort(() => {
        stopWatch();
        clearInterval(keepAlive);
        clearInterval(statusPoll);
      });
      await new Promise(() => {});
    });
  });

  app.delete("/api/memory/tests", async (c) => {
    const result = await cleanupTestMemoryRuns();
    return c.json(result);
  });

  app.delete("/api/memory/repo/:repo", async (c) => {
    const name = c.req.param("repo");
    const repo = getRepo(name);
    if (!repo) return c.json({ error: "unknown repo" }, 404);

    const lockTaskId = `memory-delete-${name}-${Date.now()}`;
    const acquired = await tryAcquireLock(name, lockTaskId);
    if (!acquired) return c.json({ error: "memory delete blocked by active run" }, 409);

    try {
      try {
        const result = await deleteRepoMemoryArtifacts(name, repo.localPath);
        const deactivatedRuns = await queries.deactivateMemoryRunsForRepo(name);
        return c.json({
          repo: name,
          deletedWorktree: result.deletedWorktree,
          deletedMemoryDir: result.deletedMemoryDir,
          deactivatedRuns,
        });
      } catch (err) {
        const message = toErrorMessage(err);
        log.error(`Memory delete failed for ${name}`, err);
        return c.json({ error: message }, 500);
      }
    } finally {
      await releaseLock(name);
    }
  });

  // --- PR Sessions ---

  app.get("/api/pr-sessions", async (c) => {
    const sourceTaskId = c.req.query("sourceTaskId");
    const sessions = sourceTaskId
      ? await queries.getPrSessionBySourceTask(sourceTaskId).then((s) => (s ? [s] : []))
      : await queries.listPrSessions();
    return c.json(sessions.map((s) => ({ ...s, prUrl: buildPrUrl(s.repo, s.prNumber) })));
  });

  app.get("/api/pr-sessions/:id", async (c) => {
    const id = c.req.param("id");
    const session = await queries.getPrSession(id);
    if (!session) return notFound(c);
    const runs = await queries.getRunsForPrSession(id);
    return c.json({ ...session, prUrl: buildPrUrl(session.repo, session.prNumber), runs });
  });

  app.get("/api/pr-sessions/:id/review", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);

    const session = await queries.getPrSession(id);
    if (!session) return notFound(c);

    const sessionDto: PrReviewPageDto["session"] = {
      id: session.id,
      repo: session.repo,
      prNumber: session.prNumber,
      prUrl: buildPrUrl(session.repo, session.prNumber),
      branch: session.branch,
      mode: session.mode,
    };

    if (!session.sourceTaskId) {
      return c.json({ session: sessionDto, run: null } satisfies PrReviewPageDto);
    }

    const paths = prReviewArtifactPaths(taskArtifactsDir(session.sourceTaskId));
    const reviewResult = await readReviewArtifact(paths.review);
    if (!reviewResult) {
      return c.json({ session: sessionDto, run: null } satisfies PrReviewPageDto);
    }

    // Lazy refresh: if the worktree HEAD has advanced past the cached headSha (e.g. the user
    // pushed commits outside of goodboy's review-chat), regenerate updatedDiff before reading.
    await maybeRefreshDiffFromWorktree(session, reviewResult.artifact.headSha);

    const diffPatch = await readFile(paths.updatedDiff, "utf8")
      .catch(() => readFile(paths.diff, "utf8"))
      .catch(() => "");

    return c.json({
      session: sessionDto,
      run: {
        ...reviewResult.artifact,
        diffPatch,
        createdAt: reviewResult.createdAt.toISOString(),
      },
    } satisfies PrReviewPageDto);
  });

  app.get("/api/pr-sessions/:id/review-chat", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);

    const session = await queries.getPrSession(id);
    if (!session) return notFound(c);

    const unavailable = reviewChatUnavailableReason(session);
    if (unavailable) {
      return c.json({ available: false, reason: unavailable, messages: [] } satisfies ReviewChatResponse);
    }

    const messages = await loadReviewChatMessages(id);
    return c.json({ available: true, reason: null, messages } satisfies ReviewChatResponse);
  });

  app.post("/api/pr-sessions/:id/review-chat", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);

    const body = reviewChatRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Invalid review chat request" }, 400);

    try {
      const result = await runReviewChatTurn({ prSessionId: id, ...body.data });
      const messages = await loadReviewChatMessages(id);
      return c.json({
        ok: true,
        changed: result.changed,
        messages,
      } satisfies ReviewChatPostResponse);
    } catch (err) {
      if (err instanceof ReviewChatNotFoundError) {
        return notFound(c);
      }
      if (err instanceof ReviewChatBusyError || err instanceof ReviewChatUnavailableError) {
        return c.json({ error: err.message }, 409);
      }
      log.error(`Review chat turn failed for ${id}`, err);
      return c.json({ error: "Review chat turn failed" }, 500);
    }
  });

  app.get("/api/pr-sessions/:id/session", async (c) => {
    const id = c.req.param("id");
    if (!UUID_PATTERN.test(id)) return notFound(c);
    const entries = await readSessionFile(prSessionPath(id));
    return c.json({ entries });
  });

  app.post("/api/pr-sessions/:id/watch", async (c) => {
    const session = await queries.getPrSession(c.req.param("id"));
    if (!session) return notFound(c);

    const parsed = prSessionWatchBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid watchStatus" }, 400);

    const updated = await queries.updatePrSession(session.id, {
      watchStatus: parsed.data.watchStatus,
      lastPolledAt: new Date(),
    });
    if (!updated) return notFound(c);

    return c.json({ ...updated, prUrl: buildPrUrl(updated.repo, updated.prNumber) });
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

function parseEnumQuery<T extends z.ZodEnum<[string, ...string[]]>>(
  schema: T,
  value: string | undefined,
): z.infer<T> | undefined {
  if (!value) return undefined;
  const result = schema.safeParse(value);
  return result.success ? result.data : undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/**
 * Build a path under `artifactsDir/<id>/<name>` after validating both segments.
 * Returns `null` if the id or name is malformed, or the resolved path escapes
 * the artifacts directory.
 */
function dedupeStageSessionRows<T extends { stage: string; variant: number | null }>(rows: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(`${row.stage}#${row.variant ?? "main"}`, row);
  return [...byKey.values()];
}

/** Stringly reason if the session cannot run review chat, else null. */
function reviewChatUnavailableReason(session: queries.PrSession): string | null {
  if (session.mode !== "review") return "Review chat is available for reviewed PRs only.";
  if (!session.sourceTaskId) return "Source review task is missing.";
  if (!session.worktreePath) return "Review worktree is no longer available.";
  if (!session.branch) return "Review branch is no longer available.";
  if (!session.prNumber) return "Review PR number is missing.";
  return null;
}

async function loadReviewChatMessages(prSessionId: string): Promise<ReviewChatMessage[]> {
  const entries = await readSessionFile(prSessionPath(prSessionId));
  return extractReviewChatMessages(entries);
}

const execFileAsync = promisify(execFile);

/** Per-session debounce so concurrent requests don't trigger overlapping refreshes. */
const refreshInFlight = new Map<string, Promise<void>>();

/**
 * Lazy diff refresh. If the session's worktree HEAD has advanced past the cached `headSha`
 * (e.g. the user pushed commits to the PR outside of goodboy's review-chat flow), regenerate
 * the `pr.updated.diff` artifact so the dashboard sees the latest changes on next read.
 * Best-effort: any failure is logged and swallowed — the stale cache is still served.
 */
async function maybeRefreshDiffFromWorktree(
  session: queries.PrSession,
  cachedHeadSha: string | undefined,
): Promise<void> {
  if (!session.sourceTaskId || !session.worktreePath || !session.prNumber) return;

  const existing = refreshInFlight.get(session.id);
  if (existing) return existing;

  const work = (async () => {
    let workHead: string;
    try {
      const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: session.worktreePath! });
      workHead = stdout.trim();
    } catch (err) {
      log.warn(`maybeRefreshDiffFromWorktree: rev-parse failed for ${session.id}: ${toErrorMessage(err)}`);
      return;
    }
    if (!workHead || workHead === cachedHeadSha) return;

    log.info(`Refreshing diff for PR session ${session.id}: cached=${cachedHeadSha ?? "<none>"} → worktree=${workHead}`);
    await refreshReviewArtifacts({
      prSessionId: session.id,
      sourceTaskId: session.sourceTaskId!,
      repo: session.repo,
      prNumber: session.prNumber!,
      worktreePath: session.worktreePath!,
    });
  })().finally(() => refreshInFlight.delete(session.id));

  refreshInFlight.set(session.id, work);
  return work;
}

function safeTaskArtifactPath(id: string, name: string): string | null {
  if (!UUID_PATTERN.test(id)) return null;
  return safeArtifactPath(id, name);
}
