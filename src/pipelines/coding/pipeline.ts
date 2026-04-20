/**
 * Coding task pipeline: sync repo -> worktree -> planner -> implementer ->
 * reviewer -> hand off to a PR session. Marks the task complete before
 * handoff; the PR session owns its own lifecycle from that point on.
 */

import path from "node:path";
import { mkdir, stat, rm } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { getRepo } from "../../shared/repos.js";
import { createWorktree, generateBranchName, syncRepo } from "../../core/worktree.js";
import * as queries from "../../db/queries.js";
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

type CodingStage = "planner" | "implementer" | "reviewer";

interface StageSpec {
  readonly label: string;
  readonly modelKey: keyof Env;
  readonly artifact: string;
  readonly artifactError: string;
}

const STAGES: Record<CodingStage, StageSpec> = {
  planner: {
    label: "Planner",
    modelKey: "PI_MODEL_PLANNER",
    artifact: "plan.md",
    artifactError: "Planner failed to write plan.md",
  },
  implementer: {
    label: "Implementer",
    modelKey: "PI_MODEL_IMPLEMENTER",
    artifact: "implementation-summary.md",
    artifactError: "Implementer failed to write implementation-summary.md",
  },
  reviewer: {
    label: "Reviewer",
    modelKey: "PI_MODEL_REVIEWER",
    artifact: "review.md",
    artifactError: "Reviewer failed to write review.md",
  },
};

const STAGE_ORDER: readonly CodingStage[] = ["planner", "implementer", "reviewer"];

// --- Entry point ---

/** Run the full coding pipeline for a task. Errors surface via `failTask`; never throws. */
export async function runPipeline(taskId: string, sendTelegram: SendTelegram): Promise<void> {
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

  const chatId = task.telegramChatId;
  await notifyTelegram(sendTelegram, chatId,
    `Task ${task.id.slice(0, 8)} started for repo ${task.repo}.\n\n${task.description}`);

  // Clean artifacts so retries start fresh.
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, chatId);
    return;
  }

  const branch = await generateBranchName(taskId, task.description);
  let worktreePath: string;
  try {
    worktreePath = await createWorktree(repo.localPath, branch, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${err}`, sendTelegram, chatId);
    return;
  }

  await queries.updateTask(taskId, { branch, worktreePath });
  const worktreeEnv: WorktreeEnv = { envNotes: repo.envNotes };

  try {
    for (const stage of STAGE_ORDER) {
      await runCodingStage(stage, { taskId, task, worktreePath, artifactsDir, worktreeEnv, sendTelegram });
      await requireArtifact(artifactsDir, STAGES[stage].artifact, STAGES[stage].artifactError);
    }

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });
    await notifyTelegram(sendTelegram, chatId,
      `Task ${task.id.slice(0, 8)} complete. Handing off to PR session...`);

    // PR session runs independently; don't await.
    startPrSession({
      originTaskId: taskId,
      repo: task.repo,
      branch,
      worktreePath,
      artifactsDir,
      sendTelegram,
      chatId: chatId!,
    }).catch((err) => {
      log.error(`PR session failed for task ${taskId}`, err);
      notifyTelegram(sendTelegram, chatId,
        `PR session failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  } catch (err) {
    await failTask(taskId, err instanceof Error ? err.message : String(err), sendTelegram, chatId);
  } finally {
    clearActiveSession(taskId);
  }
}

// --- Stage runner ---

interface StageContext {
  taskId: string;
  task: { telegramChatId: string | null; description: string };
  worktreePath: string;
  artifactsDir: string;
  worktreeEnv: WorktreeEnv;
  sendTelegram: SendTelegram;
}

async function runCodingStage(stage: CodingStage, ctx: StageContext): Promise<void> {
  const absArtifacts = path.resolve(ctx.artifactsDir);
  const spec = STAGES[stage];

  // Only the planner loads pi-subagents (for parallel exploration). Other
  // stages stay on --no-extensions for reproducibility. The planner's
  // subagents cannot themselves spawn more subagents.
  const isPlanner = stage === "planner";
  const extensions = isPlanner ? [config.subagentExtensionPath] : undefined;
  const envOverrides: Record<string, string> = isPlanner ? { PI_SUBAGENT_MAX_DEPTH: "1" } : {};

  await runStage({
    taskId: ctx.taskId,
    stage,
    cwd: ctx.worktreePath,
    systemPrompt: codingSystemPrompt(stage, absArtifacts, ctx.worktreeEnv, ctx.task.description),
    initialPrompt: codingInitialPrompt(stage, absArtifacts, ctx.task.description),
    model: modelFor(spec.modelKey),
    sendTelegram: ctx.sendTelegram,
    chatId: ctx.task.telegramChatId,
    stageLabel: spec.label,
    extensions,
    envOverrides,
  });
}

// --- Prompt routing ---

function codingSystemPrompt(
  stage: CodingStage,
  absArtifacts: string,
  env: WorktreeEnv,
  description: string,
): string {
  const planPath = path.join(absArtifacts, "plan.md");
  const summaryPath = path.join(absArtifacts, "implementation-summary.md");
  switch (stage) {
    case "planner":     return plannerPrompt(description, absArtifacts, env);
    case "implementer": return implementerPrompt(planPath, absArtifacts, env);
    case "reviewer":    return reviewerPrompt(planPath, summaryPath, absArtifacts, env);
  }
}

function codingInitialPrompt(stage: CodingStage, absArtifacts: string, description: string): string {
  const planPath = path.join(absArtifacts, "plan.md");
  const summaryPath = path.join(absArtifacts, "implementation-summary.md");
  switch (stage) {
    case "planner":
      return `Here is the task:\n\n${description}\n\nStart by exploring the codebase structure, then write the plan to ${absArtifacts}/plan.md. Do not stop until the file is written.`;
    case "implementer":
      return `Read the plan at ${planPath}, then implement every step. Make git commits as you go. When all code is written and committed, write the summary to ${absArtifacts}/implementation-summary.md. Do not stop until both the code is committed and the summary file is written.`;
    case "reviewer":
      return `Read the plan at ${planPath} and the summary at ${summaryPath}. Run git diff main to see all changes. Review the code, fix any issues, then write your review to ${absArtifacts}/review.md. Do not stop until the review file is written.`;
  }
}

// --- Helpers ---

function modelFor(key: keyof Env): string {
  const env = loadEnv();
  return (env[key] as string | undefined) ?? env.PI_MODEL;
}

/** Assert that an artifact file exists and is non-empty; throws with `errorMsg` otherwise. */
async function requireArtifact(artifactsDir: string, filename: string, errorMsg: string): Promise<void> {
  const filePath = path.join(artifactsDir, filename);
  try {
    const s = await stat(filePath);
    if (s.size === 0) throw new Error(`${errorMsg} (file is empty: ${filePath})`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(errorMsg)) throw err;
    throw new Error(`${errorMsg} (expected at ${filePath})`);
  }
}
