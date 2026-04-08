import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createLogger } from "../shared/logger.js";
import { config } from "../shared/config.js";
import { emit } from "../shared/events.js";
import type { StageName, TaskStatus } from "../shared/types.js";
import { STAGE_TO_STATUS } from "../shared/types.js";
import * as queries from "../db/queries.js";
import { spawnPiSession, type PiSession } from "./pi-rpc.js";
import { createWorktree, generateBranchName } from "./worktree.js";
import {
  plannerPrompt,
  implementerPrompt,
  reviewerPrompt,
  prCreatorPrompt,
} from "./prompts.js";

const log = createLogger("pipeline");

/** Active pi sessions indexed by task ID */
const activeSessions = new Map<string, PiSession>();

/** Callback type for sending Telegram messages */
export type SendTelegram = (chatId: string, text: string) => Promise<void>;

/** Pending reply resolvers for planner conversations */
const pendingReplies = new Map<string, (reply: string) => void>();

export function deliverReply(taskId: string, reply: string): boolean {
  const resolver = pendingReplies.get(taskId);
  if (resolver) {
    resolver(reply);
    pendingReplies.delete(taskId);
    return true;
  }
  return false;
}

export function cancelTask(taskId: string): boolean {
  const session = activeSessions.get(taskId);
  if (session) {
    session.kill();
    activeSessions.delete(taskId);
    return true;
  }
  return false;
}

export async function runPipeline(
  taskId: string,
  sendTelegram: SendTelegram
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

  const repo = await queries.getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, task.telegramChatId);
    return;
  }

  // Create artifacts directory for this task
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await mkdir(artifactsDir, { recursive: true });

  // Create worktree
  const branch = generateBranchName(taskId, task.description);
  let worktreePath: string;
  try {
    worktreePath = await createWorktree(repo.localPath, branch, taskId);
  } catch (err) {
    await failTask(taskId, `Failed to create worktree: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  await queries.updateTask(taskId, { branch, worktreePath });

  try {
    // Stage 1: Planner
    await runStage(taskId, "planner", worktreePath, artifactsDir, sendTelegram, task);

    // Stage 2: Implementer
    await runStage(taskId, "implementer", worktreePath, artifactsDir, sendTelegram, task);

    // Stage 3: Reviewer
    await runStage(taskId, "reviewer", worktreePath, artifactsDir, sendTelegram, task);

    // Stage 4: PR Creator
    await runStage(taskId, "pr_creator", worktreePath, artifactsDir, sendTelegram, task);

    // Done
    await queries.updateTask(taskId, {
      status: "complete",
      currentStage: null,
      completedAt: new Date(),
    });
    emit({ type: "task_update", taskId, status: "complete" });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    activeSessions.delete(taskId);
  }
}

async function runStage(
  taskId: string,
  stage: StageName,
  worktreePath: string,
  artifactsDir: string,
  sendTelegram: SendTelegram,
  task: Awaited<ReturnType<typeof queries.getTask>>
): Promise<void> {
  if (!task) throw new Error("Task is null");

  const status = STAGE_TO_STATUS[stage];
  await queries.updateTask(taskId, { status, currentStage: stage });
  emit({ type: "task_update", taskId, status });

  const stageRecord = await queries.createTaskStage({ taskId, stage });
  emit({ type: "stage_update", taskId, stage, status: "running" });

  log.info(`Starting stage ${stage} for task ${taskId}`);

  const systemPrompt = getSystemPrompt(stage, task.description, worktreePath, artifactsDir);

  const session = spawnPiSession({
    id: `${taskId}-${stage}`,
    cwd: worktreePath,
    systemPrompt,
    onLogLine: (line) => {
      emit({ type: "log", taskId, stage, line });
    },
  });

  activeSessions.set(taskId, session);

  // Send initial prompt to kick off the stage
  session.sendPrompt(getInitialPrompt(stage, task.description, artifactsDir));

  // Wait for completion, handling conversation loops for planner
  let result = await session.waitForCompletion();

  if (stage === "planner") {
    let marker = result.marker;
    // Handle planner conversation loop
    while (marker?.status === "needs_input") {
      const questions = marker.questions.join("\n\n");
      await sendTelegram(
        task.telegramChatId!,
        `Questions about your task:\n\n${questions}`
      );

      // Wait for user reply
      const reply = await waitForReply(taskId);
      session.sendPrompt(reply);
      result = await session.waitForCompletion();
      marker = result.marker;
    }

    if (marker?.status === "ready") {
      await sendTelegram(
        task.telegramChatId!,
        `Plan ready:\n\n${marker.summary}\n\nSend /go to proceed.`
      );
      await waitForReply(taskId); // Wait for /go
    }
  }

  await queries.updateTaskStage(stageRecord.id, {
    status: "complete",
    completedAt: new Date(),
  });
  emit({ type: "stage_update", taskId, stage, status: "complete" });

  log.info(`Stage ${stage} complete for task ${taskId}`);
}

function waitForReply(taskId: string): Promise<string> {
  return new Promise((resolve) => {
    pendingReplies.set(taskId, resolve);
  });
}

function getSystemPrompt(
  stage: StageName,
  description: string,
  worktreePath: string,
  artifactsDir: string
): string {
  const planPath = path.join(artifactsDir, "plan.md");
  const summaryPath = path.join(artifactsDir, "implementation-summary.md");
  const reviewPath = path.join(artifactsDir, "review.md");

  switch (stage) {
    case "planner":
      return plannerPrompt(description, worktreePath);
    case "implementer":
      return implementerPrompt(planPath);
    case "reviewer":
      return reviewerPrompt(planPath, summaryPath);
    case "pr_creator":
      return prCreatorPrompt("", "", planPath, summaryPath, reviewPath);
    case "revision":
      return ""; // Set dynamically
  }
}

function getInitialPrompt(
  stage: StageName,
  description: string,
  _artifactsDir: string
): string {
  switch (stage) {
    case "planner":
      return `Here is the task:\n\n${description}\n\nExplore the codebase and create a plan.`;
    case "implementer":
      return "Read plan.md and implement the changes.";
    case "reviewer":
      return "Review the implementation against the plan. Fix any issues you find.";
    case "pr_creator":
      return "Push the branch and create a GitHub PR.";
    case "revision":
      return "Address the PR feedback.";
  }
}

async function failTask(
  taskId: string,
  error: string,
  sendTelegram: SendTelegram,
  chatId: string | null
): Promise<void> {
  log.error(`Task ${taskId} failed: ${error}`);
  await queries.updateTask(taskId, { status: "failed", error });
  emit({ type: "task_update", taskId, status: "failed" });

  if (chatId) {
    await sendTelegram(chatId, `Task failed: ${error}`);
  }
}
