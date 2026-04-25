/**
 * PR review pipeline -- thin outer orchestrator.
 *
 *   syncRepo
 *     -> runMemory           (stage 1, soft-fail)
 *     -> fetch PR + diff
 *     -> createPrWorktree    (checked out on the real head branch)
 *     -> runImpactAnalyzer   (stage 2, soft-fail; produces pr-impact.md)
 *     -> runPrAnalyst        (stage 3, fans out subagents, commits, comments)
 */

import { writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { getRepoNwo } from "../../shared/repos.js";
import { createPrWorktree, removeWorktree } from "../../core/git/worktree.js";
import { getPrMetadata, getPrDiff, parsePrIdentifier } from "../../core/git/github.js";
import { runImpactAnalyzer } from "./impact-analyzer.js";
import { runPrAnalyst } from "./analyst.js";
import { failTask, clearActiveSession, completeTask, type SendTelegram } from "../../core/stage.js";
import * as queries from "../../db/repository.js";
import { toErrorMessage } from "../../shared/errors.js";
import {
  handlePipelineError,
  prepareTaskPipeline,
  withTaskPipeline,
  type TaskPipelineContext,
} from "../common.js";
import { memoryBlock } from "../../shared/agent-prompts.js";
import { PR_REVIEW_DIRS, prReviewArtifactPaths } from "./artifacts.js";

const log = createLogger("pr-review");

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
    artifactSubdirs: [PR_REVIEW_DIRS.reports],
  });
  if (!prepared) return;

  const { artifactsDir } = prepared;
  const paths = prReviewArtifactPaths(artifactsDir);

  // Fetch + persist PR metadata and diff so the impact + analyst stages can read them.
  let headRef: string;
  try {
    const metadata = await getPrMetadata(nwo, prNumber);
    const diff = await getPrDiff(nwo, prNumber);
    await writeFile(paths.context, JSON.stringify(metadata, null, 2));
    await writeFile(paths.diff, diff);
    headRef = metadata.headRef;
  } catch (err) {
    await failTask(taskId, `Failed to fetch PR context: ${toErrorMessage(err)}`, sendTelegram, chatId);
    return;
  }

  let worktreePath: string;
  try {
    worktreePath = await createPrWorktree(repo.localPath, headRef, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${toErrorMessage(err)}`, sendTelegram, chatId);
    return;
  }

  try {
    await queries.updateTask(taskId, { prNumber, worktreePath, status: "running" });

    const fullMemory = await memoryBlock(task.repo);

    // Stage 2: pr_impact. Soft-fail; analyst falls back to full memory if this drops.
    const impactAvailable = await runImpactAnalyzer({
      taskId,
      repo: task.repo,
      artifactsDir,
      worktreePath,
      sendTelegram,
      chatId,
      memoryBody: fullMemory,
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
      impactAvailable,
      fallbackMemory: impactAvailable ? "" : fullMemory,
    });

    await completeTask(taskId);
  } catch (err) {
    await handlePipelineError({
      taskId,
      err,
      sendTelegram,
      chatId,
      logCancelled: () => log.info(`Task ${taskId} cancelled mid-pipeline; halting`),
    });
  } finally {
    clearActiveSession(taskId);
    await removeWorktree(repo.localPath, worktreePath);
  }
}
