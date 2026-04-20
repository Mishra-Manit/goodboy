/**
 * PR review pipeline -- stub.
 *
 * The external PR-review flow is not implemented yet. The Telegram dispatcher
 * short-circuits `pr_review` intents before reaching this runner, so this
 * exists only to satisfy the `PIPELINES` and retry-dispatch lookups.
 */

import { createLogger } from "../../shared/logger.js";
import { failTask, type SendTelegram } from "../../core/stage.js";
import * as queries from "../../db/queries.js";

const log = createLogger("pr-review");

const NOT_IMPLEMENTED = "PR review is not implemented yet.";

export async function runPrReview(
  taskId: string,
  sendTelegram: SendTelegram,
): Promise<void> {
  log.warn(`runPrReview called for task ${taskId} but pipeline is stubbed`);
  const task = await queries.getTask(taskId);
  await failTask(taskId, NOT_IMPLEMENTED, sendTelegram, task?.telegramChatId ?? null);
}
