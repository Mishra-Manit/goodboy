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

export async function runQuestion(
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
    await failTask(taskId, `Repo '${task.repo}' not found`, sendTelegram, task.telegramChatId);
    return;
  }

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Answering question for ${task.repo}...\n\n${task.description}`,
  );

  const artifactsDir = path.join(config.artifactsDir, taskId);
  await rm(artifactsDir, { recursive: true, force: true });
  await mkdir(artifactsDir, { recursive: true });

  // Sync repo to latest origin/main
  try {
    await syncRepo(repo.localPath);
  } catch (err) {
    await failTask(taskId, `Failed to sync repo: ${err}`, sendTelegram, task.telegramChatId);
    return;
  }

  const env = loadEnv();
  const absArtifacts = path.resolve(artifactsDir);

  try {
    await runStage({
      taskId,
      stage: "answering",
      cwd: repo.localPath,
      systemPrompt: questionSystemPrompt(task.description, absArtifacts),
      initialPrompt: questionInitialPrompt(task.description, absArtifacts),
      model: env.PI_MODEL,
      sendTelegram,
      chatId: task.telegramChatId,
      stageLabel: "Answering",
    });

    // Read answer and send via Telegram
    try {
      const answer = await readFile(path.join(artifactsDir, "answer.md"), "utf-8");
      const truncated = answer.length > 1000
        ? answer.slice(0, 900) + "\n\n... (truncated, full answer in dashboard)"
        : answer;
      await notifyTelegram(sendTelegram, task.telegramChatId, truncated);
    } catch {
      await notifyTelegram(
        sendTelegram,
        task.telegramChatId,
        "Answer complete -- check the dashboard for the full response.",
      );
    }

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    clearActiveSession(taskId);
    cleanupSeqCounters(taskId);
  }
}
