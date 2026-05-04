/**
 * Codebase-question pipeline: single read-only stage that runs in the synced
 * main checkout (no worktree) and writes the answer to `answer.md`. The
 * answer is sent back over Telegram, truncated to 1000 chars.
 */

import path from "node:path";
import { readFile } from "node:fs/promises";
import { createLogger } from "../../shared/runtime/logger.js";
import { resolveModel } from "../../shared/runtime/config.js";
import { notifyTelegram, runStage, clearActiveSession, completeTask, type SendTelegram } from "../../core/stage.js";
import { questionSystemPrompt, questionInitialPrompt } from "./prompts.js";
import { questionOutputs } from "./output-contracts.js";
import { memoryBlock } from "../../core/memory/output/render.js";
import {
  handlePipelineError,
  prepareTaskPipeline,
  withTaskPipeline,
  type TaskPipelineContext,
} from "../common.js";

const log = createLogger("question");

const TELEGRAM_ANSWER_CAP = 1000;
const TELEGRAM_ANSWER_TRUNCATED_AT = 900;

// --- Entry point ---

/** Run the codebase-question pipeline. Errors surface via `failTask`; never throws. */
export async function runQuestion(taskId: string, sendTelegram: SendTelegram): Promise<void> {
  return withTaskPipeline(taskId, "codebase_question", sendTelegram, async (ctx) => {
    await runQuestionInner(ctx);
  });
}

async function runQuestionInner(
  ctx: TaskPipelineContext,
): Promise<void> {
  const { taskId, task, repo, chatId, sendTelegram } = ctx;

  const prepared = await prepareTaskPipeline({
    ctx,
    startMessage: `Answering question for ${task.repo}...\n\n${task.description}`,
  });
  if (!prepared) return;

  const { artifactsDir } = prepared;

  const memory = await memoryBlock(task.repo);
  const absArtifacts = path.resolve(artifactsDir);

  try {
    const answerOutput = questionOutputs.answer.resolve(absArtifacts, undefined);
    const result = await runStage({
      taskId,
      stage: "answering",
      cwd: repo.localPath,
      systemPrompt: questionSystemPrompt(memory, task.description, absArtifacts),
      initialPrompt: questionInitialPrompt(task.description, absArtifacts),
      model: resolveModel("PI_MODEL"),
      sendTelegram,
      chatId,
      stageLabel: "Answering",
      outputs: [answerOutput],
    });

    if (!result.ok) {
      throw new Error(`Question answer validation failed: ${result.reason}`);
    }

    await sendAnswerToTelegram(answerOutput.path, sendTelegram, chatId);

    await completeTask(taskId);
  } catch (err) {
    await handlePipelineError({
      taskId,
      err,
      sendTelegram,
      chatId,
      logCancelled: () => log.info(`Task ${taskId} cancelled mid-stage; pipeline halted`),
    });
  } finally {
    clearActiveSession(taskId);
  }
}

// --- Helpers ---

async function sendAnswerToTelegram(
  answerPath: string,
  sendTelegram: SendTelegram,
  chatId: string | null,
): Promise<void> {
  try {
    const answer = await readFile(answerPath, "utf-8");
    const message = answer.length > TELEGRAM_ANSWER_CAP
      ? `${answer.slice(0, TELEGRAM_ANSWER_TRUNCATED_AT)}\n\n... (truncated, full answer in dashboard)`
      : answer;
    await notifyTelegram(sendTelegram, chatId, message);
  } catch {
    await notifyTelegram(sendTelegram, chatId,
      "Answer complete -- check the dashboard for the full response.");
  }
}
