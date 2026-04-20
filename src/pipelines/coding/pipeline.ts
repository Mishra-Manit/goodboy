import path from "node:path";
import { mkdir, stat, rm } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { cleanupSeqCounters } from "../../core/logs.js";
import { getRepo } from "../../shared/repos.js";
import { createWorktree, generateBranchName, syncRepo } from "../../core/worktree.js";
import * as queries from "../../db/queries.js";
import type { Task } from "../../db/queries.js";
import type { Env } from "../../shared/config.js";
import {
  failTask,
  notifyTelegram,
  clearActiveSession,
  runStage,
  type SendTelegram,
} from "../../core/stage.js";
import {
  plannerPrompt,
  implementerPrompt,
  reviewerPrompt,
  type WorktreeEnv,
} from "./prompts.js";
import { startPrSession } from "../pr-session/session.js";

const log = createLogger("coding");

type CodingStageName = "planner" | "implementer" | "reviewer";

const STAGE_DISPLAY_NAMES: Record<CodingStageName, string> = {
  planner: "Planner",
  implementer: "Implementer",
  reviewer: "Reviewer",
};

const STAGE_MODEL_KEYS: Record<CodingStageName, keyof Env> = {
  planner: "PI_MODEL_PLANNER",
  implementer: "PI_MODEL_IMPLEMENTER",
  reviewer: "PI_MODEL_REVIEWER",
};

function getModelForStage(stage: CodingStageName): string {
  const env = loadEnv();
  const stageModel = env[STAGE_MODEL_KEYS[stage]] as string | undefined;
  return stageModel ?? env.PI_MODEL;
}

export async function runPipeline(
  taskId: string,
  sendTelegram: SendTelegram,
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, task.telegramChatId);
    return;
  }

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Task ${task.id.slice(0, 8)} started for repo ${task.repo}.\n\n${task.description}`,
  );

  // Clean and recreate artifacts directory so retries start fresh
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  // Sync repo to latest origin/main before branching
  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  // Create worktree
  const branch = await generateBranchName(taskId, task.description);
  let worktreePath: string;
  try {
    worktreePath = await createWorktree(repo.localPath, branch, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  await queries.updateTask(taskId, { branch, worktreePath });

  const worktreeEnv: WorktreeEnv = {
    envNotes: repo.envNotes,
  };

  try {
    // Stage 1: Planner
    await runCodingStage(taskId, "planner", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);
    await requireArtifact(artifactsDir, "plan.md", "Planner failed to write plan.md");

    // Stage 2: Implementer
    await runCodingStage(taskId, "implementer", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);
    await requireArtifact(artifactsDir, "implementation-summary.md", "Implementer failed to write implementation-summary.md");

    // Stage 3: Reviewer
    await runCodingStage(taskId, "reviewer", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);
    await requireArtifact(artifactsDir, "review.md", "Reviewer failed to write review.md");

    // Pipeline done -- mark task complete before handing off to PR session
    await queries.updateTask(taskId, {
      status: "complete",
      completedAt: new Date(),
    });
    emit({ type: "task_update", taskId, status: "complete" });

    await notifyTelegram(
      sendTelegram,
      task.telegramChatId,
      `Task ${task.id.slice(0, 8)} complete. Handing off to PR session...`,
    );

    // Hand off to PR session (runs independently)
    startPrSession({
      originTaskId: taskId,
      repo: task.repo,
      branch,
      worktreePath,
      artifactsDir,
      sendTelegram,
      chatId: task.telegramChatId!,
    }).catch((err) => {
      log.error(`PR session failed for task ${taskId}`, err);
      notifyTelegram(
        sendTelegram,
        task.telegramChatId,
        `PR session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    clearActiveSession(taskId);
    cleanupSeqCounters(taskId);
  }
}

// ---------------------------------------------------------------------------
// Generic coding stage (planner, implementer, reviewer)
// ---------------------------------------------------------------------------

async function runCodingStage(
  taskId: string,
  stage: CodingStageName,
  worktreePath: string,
  artifactsDir: string,
  sendTelegram: SendTelegram,
  task: Task,
  branch: string,
  worktreeEnv: WorktreeEnv,
): Promise<void> {
  const absArtifacts = path.resolve(artifactsDir);
  const planPath = path.join(absArtifacts, "plan.md");
  const summaryPath = path.join(absArtifacts, "implementation-summary.md");

  const systemPrompt = getCodingSystemPrompt(stage, absArtifacts, planPath, summaryPath, worktreeEnv, task.description);
  const initialPrompt = getCodingInitialPrompt(stage, absArtifacts, planPath, summaryPath, task.description);

  // Only the planner gets the pi-subagents extension for parallel codebase
  // exploration. Other stages stay on --no-extensions for reproducibility.
  const extensions = stage === "planner" ? [config.subagentExtensionPath] : undefined;

  // Cap subagent recursion depth so the planner's explorers cannot themselves
  // spawn more subagents.
  const envOverrides: Record<string, string> = stage === "planner"
    ? { PI_SUBAGENT_MAX_DEPTH: "1" }
    : {};

  await runStage({
    taskId,
    stage,
    cwd: worktreePath,
    systemPrompt,
    initialPrompt,
    model: getModelForStage(stage),
    sendTelegram,
    chatId: task.telegramChatId,
    stageLabel: STAGE_DISPLAY_NAMES[stage],
    extensions,
    envOverrides,
  });
}

// ---------------------------------------------------------------------------
// Prompt routing
// ---------------------------------------------------------------------------

function getCodingSystemPrompt(
  stage: CodingStageName,
  absArtifacts: string,
  planPath: string,
  summaryPath: string,
  worktreeEnv: WorktreeEnv,
  taskDescription: string,
): string {
  switch (stage) {
    case "planner":
      return plannerPrompt(taskDescription, absArtifacts, worktreeEnv);
    case "implementer":
      return implementerPrompt(planPath, absArtifacts, worktreeEnv);
    case "reviewer":
      return reviewerPrompt(planPath, summaryPath, absArtifacts, worktreeEnv);
  }
}

function getCodingInitialPrompt(
  stage: CodingStageName,
  absArtifacts: string,
  planPath: string,
  summaryPath: string,
  taskDescription: string,
): string {
  switch (stage) {
    case "planner":
      return `Here is the task:\n\n${taskDescription}\n\nStart by exploring the codebase structure, then write the plan to ${absArtifacts}/plan.md. Do not stop until the file is written.`;
    case "implementer":
      return `Read the plan at ${planPath}, then implement every step. Make git commits as you go. When all code is written and committed, write the summary to ${absArtifacts}/implementation-summary.md. Do not stop until both the code is committed and the summary file is written.`;
    case "reviewer":
      return `Read the plan at ${planPath} and the summary at ${summaryPath}. Run git diff main to see all changes. Review the code, fix any issues, then write your review to ${absArtifacts}/review.md. Do not stop until the review file is written.`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function requireArtifact(artifactsDir: string, filename: string, errorMsg: string): Promise<void> {
  const filePath = path.join(artifactsDir, filename);
  try {
    const s = await stat(filePath);
    if (s.size === 0) {
      throw new Error(`${errorMsg} (file is empty: ${filePath})`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(errorMsg)) throw err;
    throw new Error(`${errorMsg} (expected at ${filePath})`);
  }
}
