/**
 * Codebase-question pipeline: single read-only stage that runs in the synced
 * main checkout (no worktree) and writes the answer to `answer.md`. The
 * answer is sent back over Telegram, truncated to 1000 chars.
 */

import path from "node:path";
import { mkdir, rm, readFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config, loadEnv } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { cleanupSeqCounters } from "../../core/logs.js";
import { getRepo } from "../../shared/repos.js";
import { syncRepo } from "../../core/worktree.js";
import * as queries from "../../db/queries.js";
import {
  failTask,
  notifyTelegram,
  runStage,
  clearActiveSession,
  type SendTelegram,
} from "../../core/stage.js";
import { questionSystemPrompt, questionInitialPrompt } from "./prompts.js";

const log = createLogger("question");

const TELEGRAM_ANSWER_CAP = 1000;
const TELEGRAM_ANSWER_TRUNCATED_AT = 900;

// --- Entry point ---

/** Run the codebase-question pipeline. Errors surface via `failTask`; never throws. */
export async function runQuestion(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

  const repo = getRepo(task.repo);
  if (!repo) {
    await failTask(taskId, `Repo '${task.repo}' not found`, sendTelegram, task.telegramChatId);
    return;
  }

  const chatId = task.telegramChatId;
  await notifyTelegram(sendTelegram, chatId,
    `Answering question for ${task.repo}...\n\n${task.description}`);

  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, chatId);
    return;
  }

  const absArtifacts = path.resolve(artifactsDir);

  try {
    await runStage({
      taskId,
      stage: "answering",
      cwd: repo.localPath,
      systemPrompt: questionSystemPrompt(task.description, absArtifacts),
      initialPrompt: questionInitialPrompt(task.description, absArtifacts),
      model: loadEnv().PI_MODEL,
      sendTelegram,
      chatId,
      stageLabel: "Answering",
    });

    await sendAnswerToTelegram(artifactsDir, sendTelegram, chatId);

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });
  } catch (err) {
    await failTask(taskId, err instanceof Error ? err.message : String(err), sendTelegram, chatId);
  } finally {
    clearActiveSession(taskId);
    cleanupSeqCounters(taskId);
  }
}

// --- Helpers ---

async function sendAnswerToTelegram(
  artifactsDir: string,
  sendTelegram: SendTelegram,
  chatId: string | null,
): Promise<void> {
  try {
    const answer = await readFile(path.join(artifactsDir, "answer.md"), "utf-8");
    const message = answer.length > TELEGRAM_ANSWER_CAP
      ? `${answer.slice(0, TELEGRAM_ANSWER_TRUNCATED_AT)}\n\n... (truncated, full answer in dashboard)`
      : answer;
    await notifyTelegram(sendTelegram, chatId, message);
  } catch {
    await notifyTelegram(sendTelegram, chatId,
      "Answer complete -- check the dashboard for the full response.");
  }
}
