import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createLogger } from "../../shared/logger.js";
import { config } from "../../shared/config.js";
import { emit } from "../../shared/events.js";
import { cleanupSeqCounters } from "../logs.js";
import * as queries from "../../db/queries.js";
import {
  failTask,
  notifyTelegram,
  clearActiveSession,
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

  const artifactsDir = path.join(config.artifactsDir, taskId);
  try {
    await queries.updateTask(taskId, { status: "running" });
    emit({ type: "task_update", taskId, status: "running" });

    const stageRecord = await queries.createTaskStage({
      taskId,
      stage: "pr_reviewing",
    });
    emit({ type: "stage_update", taskId, stage: "pr_reviewing", status: "running" });

    await rm(artifactsDir, { recursive: true, force: true });
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      path.join(artifactsDir, "pr-review.md"),
      [
        "# PR Review Stub",
        "",
        "Automated PR review is not enabled yet.",
        "",
        `- Repo: ${task.repo}`,
        `- PR: ${task.prIdentifier}`,
        `- Task: ${task.id}`,
        "",
        "This request was recorded, but no review logic was run.",
      ].join("\n"),
      "utf-8",
    );

    await queries.updateTaskStage(stageRecord.id, {
      status: "complete",
      completedAt: new Date(),
    });
    emit({ type: "stage_update", taskId, stage: "pr_reviewing", status: "complete" });
    await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
    emit({ type: "task_update", taskId, status: "complete" });
    await notifyTelegram(
      sendTelegram,
      task.telegramChatId,
      `PR review is currently stubbed.\nRecorded ${task.prIdentifier} in ${task.repo}, but no automated review was run.`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failTask(taskId, message, sendTelegram, task.telegramChatId);
  } finally {
    clearActiveSession(taskId);
    cleanupSeqCounters(taskId);
  }
}
