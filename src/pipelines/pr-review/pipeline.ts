/**
 * PR review pipeline -- thin outer orchestrator.
 *
 *   syncRepo
 *     -> runMemory                (stage 1, soft-fail)
 *     -> fetch PR metadata + diff
 *     -> createPrWorktree         (checked out on the real head branch)
 *     -> runImpactAnalyzer        (stage 2, soft-fail; produces pr-impact.md)
 *     -> runPrAnalyst             (stage 3, fans out subagents, commits, comments)
 *
 * Every heavy operation lives in a named module; this file only wires them.
 */

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo, createPrWorktree, removeWorktree } from "../../core/git/worktree.js";
import {
  getPrMetadata,
  getPrDiff,
  parseNwo,
  parsePrIdentifier,
  type PrMetadata,
} from "../../core/git/github.js";
import { runMemory } from "../memory/pipeline.js";
import { runImpactAnalyzer } from "./impact-analyzer.js";
import { runPrAnalyst } from "./analyst.js";
import { failTask, notifyTelegram, type SendTelegram } from "../../core/stage.js";
import { withPipelineSpan } from "../../observability/index.js";
import * as queries from "../../db/repository.js";
import type { Task } from "../../db/repository.js";

const log = createLogger("pr-review");

// --- Public API ---

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

// --- Orchestration ---

async function runPrReviewInner(task: Task, sendTelegram: SendTelegram): Promise<void> {
  const taskId = task.id;
  const chatId = task.telegramChatId;

  const ctx = await resolvePrContext(task, sendTelegram);
  if (!ctx) return;
  const { repoPath, nwo, prNumber } = ctx;

  await notifyTelegram(sendTelegram, chatId,
    `PR review ${taskId.slice(0, 8)} starting for ${nwo}#${prNumber}.`);

  const artifactsDir = path.join(config.artifactsDir, taskId);
  await prepareArtifactsDir(artifactsDir);

  try {
    await syncRepo(repoPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${errorMessage(err)}`, sendTelegram, chatId);
    return;
  }

  // Stage 1: memory. Soft-fail; never throws.
  await runMemory({
    taskId,
    repo: task.repo,
    repoPath,
    source: "task",
    sendTelegram,
    chatId,
  });

  const prContext = await fetchPrContext(taskId, nwo, prNumber, artifactsDir, sendTelegram, chatId);
  if (!prContext) return;

  let worktreePath: string;
  try {
    worktreePath = await createPrWorktree(repoPath, prContext.headRef, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${errorMessage(err)}`, sendTelegram, chatId);
    return;
  }

  await queries.updateTask(taskId, { prNumber, worktreePath, status: "running" });

  try {
    // Stage 2: pr_impact. Soft-fail; analyst falls back to full memory if this drops.
    await runImpactAnalyzer({
      taskId,
      repo: task.repo,
      artifactsDir,
      worktreePath,
      sendTelegram,
      chatId,
    });

    // Stage 3: pr_analyst. Throws on failure.
    await runPrAnalyst({
      taskId,
      repo: task.repo,
      nwo,
      prNumber,
      headRef: prContext.headRef,
      artifactsDir,
      worktreePath,
      sendTelegram,
      chatId,
    });

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
  } catch (err) {
    await failTask(taskId, errorMessage(err), sendTelegram, chatId);
  } finally {
    await removeWorktree(repoPath, worktreePath).catch((e) =>
      log.warn(`Worktree cleanup failed for ${taskId}: ${errorMessage(e)}`),
    );
  }
}

// --- Setup helpers ---

interface PrContext {
  repoPath: string;
  nwo: string;
  prNumber: number;
}

/** Resolve repo + nwo + PR number from a task row, failing the task on any miss. */
async function resolvePrContext(task: Task, sendTelegram: SendTelegram): Promise<PrContext | null> {
  const chatId = task.telegramChatId;

  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(task.id, `Repo '${task.repo}' not found in registry`, sendTelegram, chatId);
    return null;
  }

  const prNumber = parsePrIdentifier(task.prIdentifier ?? task.description);
  if (prNumber === null) {
    await failTask(
      task.id,
      `Could not parse PR identifier: ${task.prIdentifier ?? task.description}`,
      sendTelegram,
      chatId,
    );
    return null;
  }

  const nwo = repo.githubUrl ? parseNwo(repo.githubUrl) : null;
  if (!nwo) {
    await failTask(task.id, `Repo '${task.repo}' is missing a githubUrl`, sendTelegram, chatId);
    return null;
  }

  return { repoPath: repo.localPath, nwo, prNumber };
}

/** Fetch metadata + diff, persist both to artifacts, and return the metadata. */
async function fetchPrContext(
  taskId: string,
  nwo: string,
  prNumber: number,
  artifactsDir: string,
  sendTelegram: SendTelegram,
  chatId: string | null,
): Promise<PrMetadata | null> {
  try {
    const metadata = await getPrMetadata(nwo, prNumber);
    const diff = await getPrDiff(nwo, prNumber);
    await writeFile(path.join(artifactsDir, "pr-context.json"), JSON.stringify(metadata, null, 2));
    await writeFile(path.join(artifactsDir, "pr.diff"), diff);
    return metadata;
  } catch (err) {
    await failTask(taskId, `Failed to fetch PR context: ${errorMessage(err)}`, sendTelegram, chatId);
    return null;
  }
}

/** Wipe any previous artifacts so a retry starts clean. */
async function prepareArtifactsDir(artifactsDir: string): Promise<void> {
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(path.join(artifactsDir, "reports"), { recursive: true });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
