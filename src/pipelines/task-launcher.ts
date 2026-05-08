/**
 * Platform-neutral task launcher. Telegram, dashboard routes, and E2E scripts
 * all create task rows here, then choose whether to await the pipeline handle.
 */

import { PIPELINES } from "./index.js";
import * as queries from "../db/repository.js";
import type { Task } from "../db/repository.js";
import { getRepo, listRepoNames } from "../shared/domain/repos.js";
import { emit } from "../shared/runtime/events.js";
import { createLogger } from "../shared/runtime/logger.js";
import type { SendTelegram } from "../core/stage.js";
import type { TaskKind } from "../shared/domain/types.js";

const log = createLogger("task-launcher");

export interface LaunchTaskInput {
  kind: TaskKind;
  repo: string;
  description: string;
  telegramChatId: string | null;
  prIdentifier?: string;
}

export type LaunchTaskResult =
  | { ok: true; task: Task; completion: Promise<void> }
  | { ok: false; reason: string };

/** Start an existing task row's canonical pipeline. Await this in harnesses, not chat handlers. */
export function startTaskPipeline(task: Pick<Task, "id" | "kind">, sendTelegram: SendTelegram): Promise<void> {
  return PIPELINES[task.kind](task.id, sendTelegram).catch((err) => {
    log.error(`Pipeline error for task ${task.id}`, err);
  });
}

/** Create a task row and start its canonical pipeline. Await `completion` in harnesses, not chat handlers. */
export async function createAndStartTask(
  input: LaunchTaskInput,
  sendTelegram: SendTelegram,
): Promise<LaunchTaskResult> {
  if (!getRepo(input.repo)) {
    return { ok: false, reason: `Repo '${input.repo}' not found. Available: ${listRepoNames().join(", ")}` };
  }

  const task = await queries.createTask({
    repo: input.repo,
    kind: input.kind,
    description: input.description,
    telegramChatId: input.telegramChatId,
    prIdentifier: input.prIdentifier,
  });
  emit({ type: "task_update", taskId: task.id, status: task.status, kind: task.kind });

  return { ok: true, task, completion: startTaskPipeline(task, sendTelegram) };
}
