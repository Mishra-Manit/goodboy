import { createLogger } from "../../shared/logger.js";
import { emit } from "../../shared/events.js";
import * as queries from "../../db/queries.js";
import { startExternalReview } from "../pr-session/index.js";
import {
  failTask,
  notifyTelegram,
  type SendTelegram,
} from "../shared.js";

const log = createLogger("pr-review");

export async function runPrReview(
  taskId: string,
  sendTelegram: SendTelegram,
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task || !task.prIdentifier) {
    log.error(`Task ${taskId} not found or missing prIdentifier`);
    return;
  }

  const prNumber = extractPrNumber(task.prIdentifier);
  if (!prNumber) {
    await failTask(
      taskId,
      `Could not parse PR number from: ${task.prIdentifier}`,
      sendTelegram,
      task.telegramChatId,
    );
    return;
  }

  await queries.updateTask(taskId, { status: "running" });
  emit({ type: "task_update", taskId, status: "running" });

  await notifyTelegram(
    sendTelegram,
    task.telegramChatId,
    `Starting review of PR #${prNumber} on ${task.repo}...`,
  );

  try {
    await startExternalReview({
      repo: task.repo,
      prNumber,
      sendTelegram,
      chatId: task.telegramChatId!,
      taskId,
    });

    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  }
}

function extractPrNumber(identifier: string): number | null {
  // Handle URLs like https://github.com/owner/repo/pull/42
  const urlMatch = identifier.match(/\/pull\/(\d+)/);
  if (urlMatch) return Number(urlMatch[1]);

  // Handle plain numbers like "42" or "#42"
  const numMatch = identifier.match(/#?(\d+)/);
  if (numMatch) return Number(numMatch[1]);

  return null;
}
