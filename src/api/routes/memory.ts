/** Memory status, run history, feedback, and cleanup dashboard routes. */

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import * as queries from "../../db/repository.js";
import {
  currentHeadSha,
  memoryStatus,
  releaseLock,
  tryAcquireLock,
} from "../../core/memory/index.js";
import { cleanupTestMemoryRuns } from "../../core/memory/lifecycle/cleanup.js";
import { deleteRepoMemoryArtifacts } from "../../core/memory/lifecycle/delete.js";
import { listCodeReviewerFeedback } from "../../core/memory/feedback/code-reviewer-feedback.js";
import { getRepo } from "../../shared/domain/repos.js";
import { MEMORY_RUN_KINDS } from "../../shared/domain/types.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import { createLogger } from "../../shared/runtime/logger.js";
import { readSessionFile, watchSessionFile } from "../../core/pi/session-file.js";
import { notFound, parseEnumQuery, parseLimit } from "../http.js";

const log = createLogger("api-memory");
const SSE_PING_INTERVAL_MS = 30_000;
const MEMORY_RUN_STATUS_POLL_MS = 1_000;
const memoryRunKindQuerySchema = z.enum(MEMORY_RUN_KINDS);

/** Register memory routes. */
export function registerMemoryRoutes(app: Hono): void {
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
      zones: state.zones.map((zone) => ({ name: zone.name, path: zone.path, summary: zone.summary })),
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

  app.get("/api/memory/feedback/:repo", async (c) => {
    const name = c.req.param("repo");
    if (!getRepo(name)) return c.json({ error: "unknown repo" }, 404);
    const statusFilter = c.req.query("status") ?? "all";
    const valid = ["active", "inactive", "all"] as const;
    const status = (valid as readonly string[]).includes(statusFilter)
      ? (statusFilter as "active" | "inactive" | "all")
      : "all";
    const rules = await listCodeReviewerFeedback(name, status);
    return c.json(rules);
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
}
