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

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo, createPrWorktree, removeWorktree } from "../../core/git/worktree.js";
import { getPrMetadata, getPrDiff, parseNwo, parsePrIdentifier } from "../../core/git/github.js";
import { runMemory } from "../memory/pipeline.js";
import { runImpactAnalyzer } from "./impact-analyzer.js";
import { runPrAnalyst } from "./analyst.js";
import { failTask, notifyTelegram, type SendTelegram } from "../../core/stage.js";
import { withPipelineSpan } from "../../observability/index.js";
import * as queries from "../../db/repository.js";

const log = createLogger("pr-review");

export async function runPrReview(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }
  return withPipelineSpan(
    { taskId, kind: "pr_review", repo: task.repo },
    () => runPrReviewInner(task, sendTelegram),
  );
}

async function runPrReviewInner(
  task: NonNullable<Awaited<ReturnType<typeof queries.getTask>>>,
  sendTelegram: SendTelegram,
): Promise<void> {
  const taskId = task.id;
  const chatId = task.telegramChatId;

  // Resolve repo + nwo + PR number.
  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, chatId);
    return;
  }
  const prNumber = parsePrIdentifier(task.prIdentifier ?? task.description);
  if (prNumber === null) {
    await failTask(
      taskId,
      `Could not parse PR identifier: ${task.prIdentifier ?? task.description}`,
      sendTelegram, chatId,
    );
    return;
  }
  const nwo = repo.githubUrl ? parseNwo(repo.githubUrl) : null;
  if (!nwo) {
    await failTask(taskId, `Repo '${task.repo}' is missing a githubUrl`, sendTelegram, chatId);
    return;
  }

  await notifyTelegram(sendTelegram, chatId,
    `PR review ${taskId.slice(0, 8)} starting for ${nwo}#${prNumber}.`);

  // Fresh artifacts on every (re)run. reports/ is pre-created for the analyst's subagents.
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(path.join(artifactsDir, "reports"), { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${message(err)}`, sendTelegram, chatId);
    return;
  }

  // Stage 1: memory. Soft-fail; never throws.
  await runMemory({
    taskId, repo: task.repo, repoPath: repo.localPath,
    source: "task", sendTelegram, chatId,
  });

  // Fetch + persist PR metadata and diff so the impact + analyst stages can read them.
  let headRef: string;
  try {
    const metadata = await getPrMetadata(nwo, prNumber);
    const diff = await getPrDiff(nwo, prNumber);
    await writeFile(path.join(artifactsDir, "pr-context.json"), JSON.stringify(metadata, null, 2));
    await writeFile(path.join(artifactsDir, "pr.diff"), diff);
    headRef = metadata.headRef;
  } catch (err) {
    await failTask(taskId, `Failed to fetch PR context: ${message(err)}`, sendTelegram, chatId);
    return;
  }

  let worktreePath: string;
  try {
    worktreePath = await createPrWorktree(repo.localPath, headRef, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${message(err)}`, sendTelegram, chatId);
    return;
  }

  try {
    await queries.updateTask(taskId, { prNumber, worktreePath, status: "running" });

    // Stage 2: pr_impact. Soft-fail; analyst falls back to full memory if this drops.
    await runImpactAnalyzer({
      taskId, repo: task.repo, artifactsDir, worktreePath, sendTelegram, chatId,
    });

    // Stage 3: pr_analyst. Throws on hard failure.
    await runPrAnalyst({
      taskId, repo: task.repo, nwo, prNumber, headRef,
      artifactsDir, worktreePath, sendTelegram, chatId,
    });

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
  } catch (err) {
    await failTask(taskId, message(err), sendTelegram, chatId);
  } finally {
    await removeWorktree(repo.localPath, worktreePath).catch((e) =>
      log.warn(`Worktree cleanup failed for ${taskId}: ${message(e)}`),
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
