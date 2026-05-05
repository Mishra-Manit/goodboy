/** Dashboard routes for open GitHub PR discovery and pr_review task creation. */

import type { Hono } from "hono";
import { z } from "zod";
import { isPrOpen, listOpenPrs } from "../../core/git/github.js";
import { closePrFromInbox } from "../../core/cleanup.js";
import { removeWorktree } from "../../core/git/worktree.js";
import type { SendTelegram } from "../../core/stage.js";
import * as queries from "../../db/repository.js";
import { PIPELINES } from "../../pipelines/index.js";
import { getRepo, getRepoNwo } from "../../shared/domain/repos.js";
import { emit } from "../../shared/runtime/events.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import { createLogger } from "../../shared/runtime/logger.js";
import { composePrInboxRows } from "../pr-inbox.js";

const log = createLogger("api-pr-reviews");

// Dashboard-triggered reviews are intentionally silent in Telegram.
const noopSend: SendTelegram = async () => {};

const repoQuerySchema = z.object({ repo: z.string().min(1) });
const createPrReviewBodySchema = z.object({
  repo: z.string().min(1),
  prNumber: z.number().int().positive(),
  replaceExisting: z.boolean().optional().default(false),
});

/** Register PR discovery and dashboard-triggered review routes. */
export function registerPrReviewRoutes(app: Hono): void {
  app.get("/api/github/prs", async (c) => {
    // GitHub discovery is best-effort: repo/task state can load even if `gh` is unavailable.
    const query = repoQuerySchema.safeParse({ repo: c.req.query("repo") });
    if (!query.success) return c.json({ error: "repo is required" }, 400);

    const repo = getRepo(query.data.repo);
    const nwo = getRepoNwo(query.data.repo);
    if (!repo || !nwo) return c.json({ error: "repo is not configured for GitHub" }, 404);

    const [tasks, sessions] = await Promise.all([
      queries.listPrReviewTasksForRepo(repo.name),
      queries.listPrSessionsForRepo(repo.name),
    ]);

    try {
      const openPrs = await listOpenPrs(nwo);
      return c.json({
        rows: composePrInboxRows({ repo: repo.name, openPrs, tasks, sessions }),
        githubError: null,
      });
    } catch (err) {
      log.warn(`Failed to list open PRs for ${repo.name}: ${toErrorMessage(err)}`);
      return c.json({ rows: [], githubError: toErrorMessage(err) });
    }
  });

  app.post("/api/pr-reviews", async (c) => {
    const parsed = createPrReviewBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid PR review request" }, 400);

    const { repo: repoName, prNumber, replaceExisting } = parsed.data;
    const repo = getRepo(repoName);
    const nwo = getRepoNwo(repoName);
    if (!repo || !nwo) return c.json({ error: "repo is not configured for GitHub" }, 404);

    let open: boolean;
    try {
      open = await isPrOpen(nwo, prNumber);
    } catch (err) {
      return c.json({ error: `Failed to validate PR: ${toErrorMessage(err)}` }, 502);
    }
    if (!open) return c.json({ error: "PR is not open" }, 409);

    const [tasks, sessions] = await Promise.all([
      queries.listTasksForRepoAndPr(repoName, prNumber),
      queries.listPrSessionsForRepoAndPr(repoName, prNumber),
    ]);

    // Keep the pipeline single-flight per PR; retry/rerun must not create duplicate active reviews.
    const runningReview = tasks.find((task) => task.kind === "pr_review" && (
      task.status === "queued" || task.status === "running"
    ));
    if (runningReview) {
      return c.json({ error: "Review already running", taskId: runningReview.id }, 409);
    }

    const activeReviewSession = sessions.find((session) => (
      session.mode === "review" && session.status === "active"
    ));
    const activeOwnSession = sessions.find((session) => (
      session.mode === "own" && session.status === "active"
    ));
    if (activeOwnSession && await queries.getRunningPrSessionRun(activeOwnSession.id)) {
      return c.json({ error: "Owned PR session is already running", sessionId: activeOwnSession.id }, 409);
    }

    if (activeReviewSession && !replaceExisting) {
      return c.json({
        error: "Review session already exists",
        sessionId: activeReviewSession.id,
      }, 409);
    }

    if (activeReviewSession && replaceExisting) {
      // Release the branch before starting the replacement pipeline; git only
      // allows one worktree checkout per local branch.
      if (activeReviewSession.worktreePath) {
        try {
          await removeWorktree(repo.localPath, activeReviewSession.worktreePath);
        } catch (err) {
          return c.json({ error: `Failed to remove old review worktree: ${toErrorMessage(err)}` }, 500);
        }
      }
      await queries.updatePrSession(activeReviewSession.id, {
        status: "closed",
        worktreePath: null,
        branch: null,
      });
    }

    const task = await queries.createTask({
      repo: repoName,
      kind: "pr_review",
      description: `Review PR #${prNumber}`,
      telegramChatId: null,
      prIdentifier: String(prNumber),
    });

    emit({ type: "task_update", taskId: task.id, status: task.status, kind: task.kind });
    PIPELINES.pr_review(task.id, noopSend).catch((err) => log.error(`PR review error ${task.id}`, err));

    return c.json({ ok: true, task }, 201);
  });

  app.post("/api/github/prs/:repo/:prNumber/close", async (c) => {
    const repoName = decodeURIComponent(c.req.param("repo"));
    const prNumber = parseInt(c.req.param("prNumber"), 10);
    if (!repoName || !Number.isInteger(prNumber) || prNumber <= 0) {
      return c.json({ error: "Invalid repo or PR number" }, 400);
    }
    try {
      await closePrFromInbox(repoName, prNumber);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: toErrorMessage(err) }, 502);
    }
  });
}
