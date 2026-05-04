/** PR session dashboard routes, including review page and review chat. */

import type { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import * as queries from "../../db/repository.js";
import { buildPrUrl } from "../../shared/domain/repos.js";
import { PR_SESSION_WATCH_STATUSES } from "../../shared/domain/types.js";
import { taskArtifactsDir } from "../../shared/artifacts/index.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import { createLogger } from "../../shared/runtime/logger.js";
import { readSessionFile, prSessionPath } from "../../core/pi/session-file.js";
import { prReviewArtifactPaths } from "../../pipelines/pr-review/artifacts/index.js";
import { readReviewArtifact } from "../../pipelines/pr-review/artifacts/read-review.js";
import { refreshReviewArtifacts } from "../../pipelines/pr-session/refresh-review.js";
import { extractReviewChatMessages } from "../../pipelines/pr-session/review-chat/index.js";
import {
  ReviewChatBusyError,
  ReviewChatNotFoundError,
  ReviewChatUnavailableError,
  runReviewChatTurn,
} from "../../pipelines/pr-session/session.js";
import {
  reviewChatRequestSchema,
  type PrReviewPageDto,
  type ReviewChatMessage,
  type ReviewChatPostResponse,
  type ReviewChatResponse,
} from "../../shared/contracts/pr-review.js";
import { exec } from "../../core/git/exec.js";
import { notFound, UUID_PATTERN } from "../http.js";

const log = createLogger("api-pr-sessions");
const prSessionWatchBodySchema = z.object({
  watchStatus: z.enum(PR_SESSION_WATCH_STATUSES),
});

/** Per-session debounce so concurrent requests don't trigger overlapping refreshes. */
const refreshInFlight = new Map<string, Promise<void>>();

/** Register PR session routes. */
export function registerPrSessionRoutes(app: Hono): void {
  app.get("/api/pr-sessions", async (c) => {
    const sourceTaskId = c.req.query("sourceTaskId");
    const sessions = sourceTaskId
      ? await queries.getPrSessionBySourceTask(sourceTaskId).then((session) => (session ? [session] : []))
      : await queries.listPrSessions();
    return c.json(sessions.map((session) => ({
      ...session,
      prUrl: buildPrUrl(session.repo, session.prNumber),
    })));
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
      if (err instanceof ReviewChatNotFoundError) return notFound(c);
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

/**
 * Lazy diff refresh. If the session's worktree HEAD has advanced past the cached `headSha`,
 * regenerate the updated diff artifact before serving the review page. Best-effort.
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
      const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: session.worktreePath! });
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
