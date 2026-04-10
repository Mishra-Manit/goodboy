import path from "node:path";
import { mkdir, access, rm } from "node:fs/promises";
import { createLogger } from "../shared/logger.js";
import { config, getPiModel } from "../shared/config.js";
import { emit } from "../shared/events.js";
import type { StageName, TaskStatus } from "../shared/types.js";
import { STAGE_TO_STATUS } from "../shared/types.js";
import * as queries from "../db/queries.js";
import { getRepo } from "../shared/repos.js";
import { spawnPiSession, type PiSession } from "./pi-rpc.js";
import { createWorktree, generateBranchName } from "./worktree.js";
import {
  plannerPrompt,
  implementerPrompt,
  reviewerPrompt,
  prCreatorPrompt,
  type WorktreeEnv,
} from "./prompts.js";
import { appendLogEntry, makeEntry, resetSeq } from "./logs.js";

const log = createLogger("pipeline");

/** Active pi sessions indexed by task ID */
const activeSessions = new Map<string, PiSession>();

/** Concurrency gate -- resolvers waiting for a slot */
const waitingForSlot: Array<() => void> = [];
let runningCount = 0;

async function acquireSlot(): Promise<void> {
  if (runningCount < config.maxParallelTasks) {
    runningCount++;
    return;
  }
  await new Promise<void>((resolve) => {
    waitingForSlot.push(resolve);
  });
  runningCount++;
}

function releaseSlot(): void {
  runningCount--;
  const next = waitingForSlot.shift();
  if (next) next();
}

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

  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, task.telegramChatId);
    return;
  }

  // Wait for a concurrency slot
  await acquireSlot();
  log.info(`Acquired slot for task ${taskId} (${runningCount}/${config.maxParallelTasks} running)`);

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Task ${task.id.slice(0, 8)} started for repo ${task.repo}.\n\n${task.description}`
  );

  // Clean and recreate artifacts directory so retries start fresh
  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  // Create worktree
  const branch = generateBranchName(taskId, task.description);
  let worktreePath: string;
  try {
    worktreePath = await createWorktree(repo.localPath, branch, taskId);
  } catch (err) {
    releaseSlot();
    await failTask(taskId, `Failed to create worktree: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  await queries.updateTask(taskId, { branch, worktreePath });

  // Build worktree environment context from repo config
  const worktreeEnv: WorktreeEnv = {
    envNotes: repo.envNotes,
  };

  try {
    // Stage 1: Planner
    await runStage(taskId, "planner", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);
    await requireArtifact(artifactsDir, "plan.md", "Planner failed to write plan.md");

    // Stage 2: Implementer
    await runStage(taskId, "implementer", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);
    await requireArtifact(artifactsDir, "implementation-summary.md", "Implementer failed to write implementation-summary.md");

    // Stage 3: Reviewer
    await runStage(taskId, "reviewer", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);
    await requireArtifact(artifactsDir, "review.md", "Reviewer failed to write review.md");

    // Stage 4: PR Creator
    await runStage(taskId, "pr_creator", worktreePath, artifactsDir, sendTelegram, task, branch, worktreeEnv);

    // Done
    await queries.updateTask(taskId, {
      status: "complete",
      completedAt: new Date(),
    });
    emit({ type: "task_update", taskId, status: "complete" });

    await notifyTelegram(
      sendTelegram,
      task.telegramChatId,
      `Task ${task.id.slice(0, 8)} is complete.`
    );

    // Note: worktree is NOT cleaned up here because GitHub webhook
    // revisions may still need it. Worktrees should be cleaned up
    // manually or via a periodic cleanup job after PR merge.

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    activeSessions.delete(taskId);
    releaseSlot();
  }
}

async function runStage(
  taskId: string,
  stage: StageName,
  worktreePath: string,
  artifactsDir: string,
  sendTelegram: SendTelegram,
  task: Awaited<ReturnType<typeof queries.getTask>>,
  branch: string,
  worktreeEnv?: WorktreeEnv
): Promise<void> {
  if (!task) throw new Error("Task is null");

  const status = STAGE_TO_STATUS[stage];
  await queries.updateTask(taskId, { status });
  emit({ type: "task_update", taskId, status });

  const stageRecord = await queries.createTaskStage({ taskId, stage });
  emit({ type: "stage_update", taskId, stage, status: "running" });

  log.info(`Starting stage ${stage} for task ${taskId}`);

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Stage started: ${formatStageName(stage)}.`
  );

  const systemPrompt = getSystemPrompt(stage, task.description, worktreePath, artifactsDir, branch, task.repo, worktreeEnv);

  resetSeq(taskId, stage);

  const session = spawnPiSession({
    id: `${taskId}-${stage}`,
    cwd: worktreePath,
    systemPrompt,
    model: getPiModel(),
    onLog: (kind, text, meta) => {
      const entry = makeEntry(taskId, stage, kind, text, meta);
      emit({ type: "log", taskId, stage, entry });
      appendLogEntry(taskId, stage, entry).catch(() => {});
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

  // Kill the pi session to free resources before next stage
  session.kill();
  activeSessions.delete(taskId);

  await queries.updateTaskStage(stageRecord.id, {
    status: "complete",
    completedAt: new Date(),
  });
  emit({ type: "stage_update", taskId, stage, status: "complete" });

  if (stage === "pr_creator") {
    const prUrl = extractPrUrl(result.fullOutput);
    const prNumber = prUrl ? extractPrNumber(prUrl) : null;

    if (prUrl) {
      await queries.updateTask(taskId, { prUrl, prNumber });
      emit({ type: "pr_update", taskId, prUrl });

      await notifyTelegram(
        sendTelegram,
        task.telegramChatId,
        `PR is up and ready for review:\n${prUrl}`
      );
    } else {
      await notifyTelegram(
        sendTelegram,
        task.telegramChatId,
        "PR creator finished, but I could not detect the PR URL from output. Please verify in GitHub."
      );
    }
  } else {
    await notifyTelegram(
      sendTelegram,
      task.telegramChatId,
      `Stage complete: ${formatStageName(stage)}.`
    );
  }

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
  _worktreePath: string,
  artifactsDir: string,
  branch: string,
  repoName: string,
  worktreeEnv?: WorktreeEnv
): string {
  // Use absolute paths so pi can find them regardless of CWD
  const absArtifacts = path.resolve(artifactsDir);
  const planPath = path.join(absArtifacts, "plan.md");
  const summaryPath = path.join(absArtifacts, "implementation-summary.md");
  const reviewPath = path.join(absArtifacts, "review.md");

  switch (stage) {
    case "planner":
      return plannerPrompt(description, absArtifacts, worktreeEnv);
    case "implementer":
      return implementerPrompt(planPath, absArtifacts, worktreeEnv);
    case "reviewer":
      return reviewerPrompt(planPath, summaryPath, absArtifacts, worktreeEnv);
    case "pr_creator":
      return prCreatorPrompt(branch, repoName, planPath, summaryPath, reviewPath);
    case "revision":
      return ""; // Set dynamically
  }
}

function getInitialPrompt(
  stage: StageName,
  description: string,
  artifactsDir: string
): string {
  const absArtifacts = path.resolve(artifactsDir);
  switch (stage) {
    case "planner":
      return `Here is the task:\n\n${description}\n\nStart by exploring the codebase structure, then write the plan to ${absArtifacts}/plan.md. Do not stop until the file is written.`;
    case "implementer":
      return `Read the plan at ${absArtifacts}/plan.md, then implement every step. Make git commits as you go. When all code is written and committed, write the summary to ${absArtifacts}/implementation-summary.md. Do not stop until both the code is committed and the summary file is written.`;
    case "reviewer":
      return `Read the plan at ${absArtifacts}/plan.md and the summary at ${absArtifacts}/implementation-summary.md. Run git diff main to see all changes. Review the code, fix any issues, then write your review to ${absArtifacts}/review.md. Do not stop until the review file is written.`;
    case "pr_creator":
      return `Push the branch to origin and create a GitHub PR using gh CLI. Read the artifact files for context on what to put in the PR description.`;
    case "revision":
      return "Read the PR feedback, make the fixes, commit, and push.";
  }
}

async function requireArtifact(artifactsDir: string, filename: string, errorMsg: string): Promise<void> {
  const filePath = path.join(artifactsDir, filename);
  try {
    await access(filePath);
  } catch {
    throw new Error(errorMsg + ` (expected at ${filePath})`);
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
    await notifyTelegram(sendTelegram, chatId, `Task failed: ${error}`);
  }
}

async function notifyTelegram(
  sendTelegram: SendTelegram,
  chatId: string | null,
  text: string
): Promise<void> {
  if (!chatId) return;

  try {
    await sendTelegram(chatId, text);
  } catch (err) {
    log.warn(`Failed to send Telegram message for chat ${chatId}: ${String(err)}`);
  }
}

function formatStageName(stage: StageName): string {
  switch (stage) {
    case "planner":
      return "Planner";
    case "implementer":
      return "Implementer";
    case "reviewer":
      return "Reviewer";
    case "pr_creator":
      return "PR Creator";
    case "revision":
      return "Revision";
  }
}

function extractPrUrl(text: string): string | null {
  const matches = text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1];
}

function extractPrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}
