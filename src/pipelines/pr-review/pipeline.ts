/**
 * PR review pipeline -- thin outer orchestrator.
 *
 *   syncRepo
 *     -> runMemory           (stage 1, soft-fail)
 *     -> fetch PR metadata
 *     -> createPrWorktree    (checked out on the real head branch)
 *     -> fetch diff via git diff inside worktree (respects PR_DIFF_CONTEXT_LINES)
 *     -> runImpactAnalyzers  (stage 2, soft-fail; produces pr-impact.vN.md)
 *     -> runPrAnalyst        (stage 3, fans out subagents, commits, comments)
 *     -> runPrDisplay        (stage 4, writes dashboard review.json; soft-fail)
 */

import { writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/runtime/logger.js";
import { getRepoNwo } from "../../shared/domain/repos.js";
import { createPrWorktree, removeWorktree, worktreeExists } from "../../core/git/worktree.js";
import { getPrMetadata, getPrDiff, parsePrIdentifier } from "../../core/git/github.js";
import { runImpactAnalyzers } from "./stages/impact-analyzer.js";
import { runPrAnalyst } from "./stages/analyst.js";
import { runPrDisplay } from "./stages/display.js";
import { handoffExternalReview } from "../pr-session/session.js";
import { failTask, clearActiveSession, completeTask, type SendTelegram } from "../../core/stage.js";
import * as queries from "../../db/repository.js";
import { toErrorMessage } from "../../shared/runtime/errors.js";
import {
  handlePipelineError,
  prepareTaskPipeline,
  withTaskPipeline,
  type TaskPipelineContext,
} from "../common.js";
import { memoryBlock } from "../../core/memory/output/render.js";
import { codeReviewerFeedbackBlock } from "../../core/memory/feedback/code-reviewer-feedback.js";
import { PR_IMPACT_VARIANT_COUNT, PR_REVIEW_REPORTS_DIR, prImpactVariantPaths, prReviewOutputs } from "./output-contracts.js";
import { permuteDiff } from "./diff/permute.js";

const log = createLogger("pr-review");

const OWNED_REVIEW_POLL_CURSOR_BUFFER_MS = 30_000;

export async function runPrReview(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  return withTaskPipeline(taskId, "pr_review", sendTelegram, async (ctx) => {
    await runPrReviewInner(ctx);
  });
}

async function runPrReviewInner(
  ctx: TaskPipelineContext,
): Promise<void> {
  const { taskId, task, repo, chatId, sendTelegram } = ctx;

  // Resolve nwo + PR number.
  const prNumber = parsePrIdentifier(task.prIdentifier ?? task.description);
  if (prNumber === null) {
    await failTask(
      taskId,
      `Could not parse PR identifier: ${task.prIdentifier ?? task.description}`,
      sendTelegram, chatId,
    );
    return;
  }
  const nwo = getRepoNwo(task.repo);
  if (!nwo) {
    await failTask(taskId, `Repo '${task.repo}' is missing a githubUrl`, sendTelegram, chatId);
    return;
  }

  const prepared = await prepareTaskPipeline({
    ctx,
    startMessage: `PR review ${taskId.slice(0, 8)} starting for ${nwo}#${prNumber}.`,
    artifactSubdirs: [PR_REVIEW_REPORTS_DIR],
  });
  if (!prepared) return;

  const { artifactsDir } = prepared;
  const paths = {
    context: prReviewOutputs.context.resolve(artifactsDir, undefined).path,
    diff: prReviewOutputs.diff.resolve(artifactsDir, undefined).path,
    updatedContext: prReviewOutputs.updatedContext.resolve(artifactsDir, undefined).path,
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    reviewerFeedback: prReviewOutputs.reviewerFeedback.resolve(artifactsDir, undefined).path,
  };

  // Fetch PR metadata first — we need headRef and baseRef to create the worktree
  // and to run git diff inside it.
  let headRef: string;
  let baseRef: string;
  try {
    const metadata = await getPrMetadata(nwo, prNumber);
    await writeFile(paths.context, JSON.stringify(metadata, null, 2));
    headRef = metadata.headRef;
    baseRef = metadata.baseRef;
  } catch (err) {
    await failTask(taskId, `Failed to fetch PR metadata: ${toErrorMessage(err)}`, sendTelegram, chatId);
    return;
  }

  const ownedSession = await findOwnedPrSession(task.repo, prNumber);
  let ownedReviewRunId: string | null = null;
  let ownedReviewSessionId: string | null = null;
  let worktreePath: string;
  let ownsWorktree = false;

  if (ownedSession) {
    const borrowed = await borrowOwnedWorktree(ownedSession);
    if (!borrowed.ok) {
      await failTask(taskId, borrowed.reason, sendTelegram, chatId);
      return;
    }
    worktreePath = borrowed.worktreePath;
    ownedReviewRunId = borrowed.runId;
    ownedReviewSessionId = ownedSession.id;
  } else {
    try {
      worktreePath = await createPrWorktree(repo.localPath, headRef, taskId);
      ownsWorktree = true;
    } catch (err) {
      await failTask(taskId, `Failed to create worktree: ${toErrorMessage(err)}`, sendTelegram, chatId);
      return;
    }
  }

  // Once handoffExternalReview persists the pr_sessions row, the worktree
  // belongs to the session and the pipeline must not delete it. `ownsWorktree`
  // gates cleanup for external reviews; owned reviews only borrow a session
  // worktree and must never remove it.

  try {
    // Diff is fetched after the worktree exists so we can run git diff inside it,
    // giving us configurable context lines (PR_DIFF_CONTEXT_LINES) instead of
    // the fixed 3-line context that gh pr diff returns.
    const diff = await getPrDiff(worktreePath, baseRef);
    await writeFile(paths.diff, diff);
    const diffVariants = padDiffVariants(permuteDiff(diff, taskId, PR_IMPACT_VARIANT_COUNT));
    await Promise.all(diffVariants.map((variant) => (
      writeFile(prImpactVariantPaths(artifactsDir, variant.variant).diff, variant.diff)
    )));

    await queries.updateTask(taskId, {
      prNumber,
      status: "running",
      ...(ownsWorktree ? { worktreePath } : {}),
    });

    const fullMemory = await memoryBlock(task.repo);
    const reviewerFeedback = await codeReviewerFeedbackBlock(task.repo);
    await writeFile(paths.reviewerFeedback, reviewerFeedback || "No active code reviewer feedback rules.\n");

    // Stage 2: pr_impact fanout. Soft-fail; analyst falls back to full memory if all variants drop.
    const impactResult = await runImpactAnalyzers({
      taskId,
      repo: task.repo,
      artifactsDir,
      worktreePath,
      sendTelegram,
      memoryBody: fullMemory,
      reviewerFeedback,
    });

    // Stage 3: pr_analyst. Throws on hard failure.
    await runPrAnalyst({
      taskId,
      repo: task.repo,
      nwo,
      prNumber,
      headRef,
      artifactsDir,
      worktreePath,
      sendTelegram,
      chatId,
      availableImpactVariants: impactResult.available,
      fallbackMemory: impactResult.ok ? "" : fullMemory,
      reviewerFeedback,
    });

    // Snapshot post-analyst PR state so pr_display renders the actual reviewed diff.
    try {
      const updatedMetadata = await getPrMetadata(nwo, prNumber);
      const updatedDiff = await getPrDiff(worktreePath, baseRef);
      await writeFile(paths.updatedContext, JSON.stringify(updatedMetadata, null, 2));
      await writeFile(paths.updatedDiff, updatedDiff);
    } catch (err) {
      log.warn(`Failed to re-fetch PR state for ${taskId}; pr_display will likely be unavailable`, err);
    }

    // Stage 4: pr_display. Soft-fail; GitHub summary and PR session still proceed.
    await runPrDisplay({
      taskId,
      repo: task.repo,
      nwo,
      prNumber,
      artifactsDir,
      worktreePath,
      sendTelegram,
      chatId,
      availableImpactVariants: impactResult.available,
    });

    if (ownedReviewRunId) {
      if (ownedReviewSessionId) {
        // Advance the cursor BEFORE completing the run so the poller cannot race
        // in between the two writes and pick up the analyst's self-authored comment.
        // The run is still "running" here, keeping the poller's busy-guard active.
        await queries.updatePrSession(ownedReviewSessionId, {
          mode: "review",
          sourceTaskId: taskId,
          lastPolledAt: new Date(Date.now() + OWNED_REVIEW_POLL_CURSOR_BUFFER_MS),
        });
      }
      await queries.completePrSessionRun(ownedReviewRunId);
    } else {
      // Promote the finished external review into a watchable PR session. The
      // session takes ownership of the worktree from this point on.
      await handoffExternalReview({
        sourceTaskId: taskId,
        repo: task.repo,
        prNumber,
        branch: headRef,
        worktreePath,
        chatId,
      });
      ownsWorktree = false;
    }

    await completeTask(taskId);
  } catch (err) {
    if (ownedReviewRunId) await queries.failPrSessionRun(ownedReviewRunId, toErrorMessage(err));
    await handlePipelineError({
      taskId,
      err,
      sendTelegram,
      chatId,
      logCancelled: () => log.info(`Task ${taskId} cancelled mid-pipeline; halting`),
    });
  } finally {
    clearActiveSession(taskId);
    if (ownsWorktree) {
      await removeWorktree(repo.localPath, worktreePath);
    }
  }
}

async function findOwnedPrSession(repo: string, prNumber: number): Promise<queries.PrSession | null> {
  const sessions = await queries.listPrSessionsForRepoAndPr(repo, prNumber);
  return sessions.find((session) => session.mode === "own" && session.status === "active") ?? null;
}

type BorrowedOwnedWorktree =
  | { ok: true; worktreePath: string; runId: string }
  | { ok: false; reason: string };

/** Borrow an owned PR session's checkout without taking cleanup ownership. */
async function borrowOwnedWorktree(session: queries.PrSession): Promise<BorrowedOwnedWorktree> {
  if (!session.worktreePath) return { ok: false, reason: "Owned PR session has no worktree to review." };
  if (!await worktreeExists(session.worktreePath)) {
    return { ok: false, reason: "Owned PR session worktree is missing. Run reconcile, then retry review." };
  }

  const running = await queries.getRunningPrSessionRun(session.id);
  if (running) return { ok: false, reason: "Owned PR session is already running. Retry after it finishes." };

  const run = await queries.createPrSessionRun({
    prSessionId: session.id,
    trigger: "review",
  });
  return { ok: true, worktreePath: session.worktreePath, runId: run.id };
}

function padDiffVariants(
  variants: ReturnType<typeof permuteDiff>,
): ReturnType<typeof permuteDiff> {
  // Empty/binary-only diffs have no `diff --git` blocks, so permuteDiff returns
  // v1 only. Still write all configured diff files so every variant has input.
  const fallback = variants[0];
  if (!fallback) return [];
  return Array.from({ length: PR_IMPACT_VARIANT_COUNT }, (_, index) => (
    variants[index] ?? { ...fallback, variant: index + 1 }
  ));
}
