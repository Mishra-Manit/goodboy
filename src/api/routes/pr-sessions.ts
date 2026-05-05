/** PR session dashboard routes, including review page and review chat. */

import type { Hono } from "hono";
import { z } from "zod";
import * as queries from "../../db/repository.js";
import { buildPrUrl } from "../../shared/domain/repos.js";
import { PR_SESSION_WATCH_STATUSES } from "../../shared/domain/types.js";
import { createLogger } from "../../shared/runtime/logger.js";
import { readSessionFile, prSessionPath } from "../../core/pi/session-file.js";
import { reconcilePrSessions } from "../../core/pr-session/reconcile.js";
import { buildSessionPrReviewPage } from "../pr-review-page.js";
import { extractReviewChatMessages } from "../../pipelines/pr-session/review-chat/index.js";
import {
  ReviewChatBusyError,
  ReviewChatNotFoundError,
  ReviewChatUnavailableError,
  runReviewChatTurn,
} from "../../pipelines/pr-session/session.js";
import {
  reviewChatRequestSchema,
  type ReviewChatMessage,
  type ReviewChatPostResponse,
  type ReviewChatResponse,
} from "../../shared/contracts/pr-review.js";
import { notFound, UUID_PATTERN } from "../http.js";

const log = createLogger("api-pr-sessions");
const prSessionWatchBodySchema = z.object({
  watchStatus: z.enum(PR_SESSION_WATCH_STATUSES),
});

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

  app.post("/api/pr-sessions/reconcile", async (c) => {
    const apply = c.req.query("apply") === "1";
    return c.json(await reconcilePrSessions(apply));
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

    return c.json(await buildSessionPrReviewPage(session));
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

