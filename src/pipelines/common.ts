/**
 * Shared task-pipeline orchestration helpers. Centralizes the repeated shell
 * around loading a task, resolving its repo, resetting cancellation, preparing
 * artifacts, syncing the repo, and running the memory stage.
 */

import { withPipelineSpan } from "../observability/index.js";
import * as queries from "../db/repository.js";
import { getRepo, type Repo } from "../shared/repos.js";
import { prepareArtifactsDir } from "../shared/artifacts.js";
import { syncRepo } from "../core/git/worktree.js";
import {
  failTask,
  notifyTelegram,
  resetTaskCancellation,
  isTaskCancelled,
  TaskCancelledError,
  type SendTelegram,
} from "../core/stage.js";
import { runMemory } from "./memory/pipeline.js";
import { createLogger } from "../shared/logger.js";
import { toErrorMessage } from "../shared/errors.js";
import type { TaskKind } from "../shared/types.js";

const log = createLogger("pipeline-common");

export type PipelineTask = NonNullable<Awaited<ReturnType<typeof queries.getTask>>>;

export interface TaskPipelineContext {
  taskId: string;
  task: PipelineTask;
  repo: Repo;
  chatId: string | null;
  sendTelegram: SendTelegram;
}

export interface PreparedTaskPipelineContext extends TaskPipelineContext {
  artifactsDir: string;
}

// --- Entry wrapper ---

/** Load a task, resolve its repo, reset cancellation, and run inside the pipeline span. */
export async function withTaskPipeline(
  taskId: string,
  kind: TaskKind,
  sendTelegram: SendTelegram,
  body: (ctx: TaskPipelineContext) => Promise<void>,
): Promise<void> {
  const task = await queries.getTask(taskId);
  if (!task) {
    log.error(`Task ${taskId} not found`);
    return;
  }

  return withPipelineSpan(
    { taskId, kind, repo: task.repo },
    async () => {
      const repo = getRepo(task.repo);
      if (!repo) {
        await failTask(taskId, `Repo '${task.repo}' not found in registry`, sendTelegram, task.telegramChatId);
        return;
      }

      resetTaskCancellation(taskId);
      await body({
        taskId,
        task,
        repo,
        chatId: task.telegramChatId,
        sendTelegram,
      });
    },
  );
}

// --- Shared setup ---

interface PrepareTaskPipelineOptions {
  ctx: TaskPipelineContext;
  startMessage: string;
  artifactSubdirs?: readonly string[];
}

/** Prepare artifacts, sync the repo, run memory, and halt early on failure/cancellation. */
export async function prepareTaskPipeline(
  options: PrepareTaskPipelineOptions,
): Promise<PreparedTaskPipelineContext | null> {
  const { ctx, startMessage, artifactSubdirs = [] } = options;

  await notifyTelegram(ctx.sendTelegram, ctx.chatId, startMessage);

  let artifactsDir: string;
  try {
    artifactsDir = await prepareArtifactsDir(ctx.taskId, artifactSubdirs);
  } catch (err) {
    await failTask(ctx.taskId, `Failed to prepare artifacts: ${toErrorMessage(err)}`, ctx.sendTelegram, ctx.chatId);
    return null;
  }

  try {
    await syncRepo(ctx.repo.localPath);
  } catch (err) {
    await failTask(ctx.taskId, `Failed to sync repo: ${toErrorMessage(err)}`, ctx.sendTelegram, ctx.chatId);
    return null;
  }

  await runMemory({
    taskId: ctx.taskId,
    repo: ctx.task.repo,
    repoPath: ctx.repo.localPath,
    source: "task",
    sendTelegram: ctx.sendTelegram,
    chatId: ctx.chatId,
  });

  if (isTaskCancelled(ctx.taskId)) {
    log.info(`Task ${ctx.taskId} cancelled during memory stage; halting pipeline`);
    return null;
  }

  return { ...ctx, artifactsDir };
}

// --- Error handling ---

/** Standard top-level pipeline catch for task stages. */
export async function handlePipelineError(options: {
  taskId: string;
  err: unknown;
  sendTelegram: SendTelegram;
  chatId: string | null;
  logCancelled: () => void;
}): Promise<void> {
  if (options.err instanceof TaskCancelledError) {
    options.logCancelled();
    return;
  }

  await failTask(options.taskId, toErrorMessage(options.err), options.sendTelegram, options.chatId);
}
