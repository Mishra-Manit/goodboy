/**
 * Stage orchestration primitives shared by every pipeline: the active-session
 * registry (for cancellation), Telegram notification wrapper, task-failure
 * helper, timeout combinator, and `runStage` -- the generic pi-RPC subprocess
 * runner that every task kind uses.
 *
 * Pi writes its own session JSONL to `sessionPath`; we tail it for SSE
 * broadcast, so this module doesn't touch logs directly.
 */

import { createLogger } from "../shared/runtime/logger.js";
import { emit } from "../shared/runtime/events.js";
import { toErrorMessage } from "../shared/runtime/errors.js";
import * as queries from "../db/repository.js";
import { spawnPiSession, type PiSession } from "./pi/spawn.js";
import { ensureSessionDir, taskSessionPath } from "./pi/session-file.js";
import { broadcastSessionFile } from "./pi/session-broadcast.js";
import { withStageSpan, bridgeSessionToOtel } from "../observability/index.js";
import { releaseMemoryLockForTask } from "./memory/index.js";
import type { StageName } from "../shared/domain/types.js";

const log = createLogger("stage");

// --- Task identity ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `taskId` is a real `tasks.id` UUID (vs a manual-test label). */
export function isPersistedTaskId(taskId: string): boolean {
  return UUID_RE.test(taskId);
}

// --- Session registry ---

const activeSessions = new Map<string, Map<string, PiSession>>();
const cancelledTasks = new Set<string>();

/**
 * Thrown by `runStage` when a task has been cancelled. Pipelines catch this
 * to skip `failTask` (the API already wrote `status: cancelled`) and bail
 * without running further stages.
 */
export class TaskCancelledError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} cancelled`);
    this.name = "TaskCancelledError";
  }
}

/** Stable key for one stage run inside a task. */
export function stageRunKey(stage: StageName, variant?: number): string {
  return variant === undefined ? stage : `${stage}#${variant}`;
}

/** Register the live pi session for a task stage run so cancellation can find it. */
export function setActiveSession(taskId: string, stage: StageName, session: PiSession, variant?: number): void {
  const taskSessions = activeSessions.get(taskId) ?? new Map<string, PiSession>();
  activeSessions.set(taskId, new Map(taskSessions).set(stageRunKey(stage, variant), session));
}

/** Drop one active stage-run entry, or all entries for the task when no stage is passed. */
export function clearActiveSession(taskId: string, stage?: StageName, variant?: number): void {
  if (!stage) {
    activeSessions.delete(taskId);
    return;
  }

  const taskSessions = activeSessions.get(taskId);
  if (!taskSessions) return;
  const next = new Map(taskSessions);
  next.delete(stageRunKey(stage, variant));
  if (next.size === 0) activeSessions.delete(taskId);
  else activeSessions.set(taskId, next);
}

/**
 * Mark a task as cancelled and kill its live pi session if one is registered.
 * Killing the pi child causes `runStage` to throw `TaskCancelledError`, which
 * propagates out of any wrapper (e.g. `withMemoryRun`) so that wrapper's own
 * finally blocks release their resources — including the memory `.lock`
 * file. This function also best-effort removes the lock itself as a safety
 * net in case that finally never ran (e.g. pipeline crashed between lock
 * acquisition and entering the try block).
 *
 * Returns `true` if a session was killed or a memory lock was released.
 * The cancelled flag persists until `resetTaskCancellation` is called
 * (typically by a retry), so any stage spawned after this point short-
 * circuits via `runStage`'s entry check.
 */
export async function cancelTask(taskId: string): Promise<boolean> {
  cancelledTasks.add(taskId);

  const sessions = activeSessions.get(taskId);
  if (sessions) {
    for (const session of sessions.values()) session.kill();
    activeSessions.delete(taskId);
  }

  const lockReleased = await releaseMemoryLockForTask(taskId);
  if (lockReleased) log.info(`Released memory lock for cancelled task ${taskId}`);

  return !!sessions?.size || lockReleased;
}

/** True if `cancelTask` has been called for this task and it has not been reset. */
export function isTaskCancelled(taskId: string): boolean {
  return cancelledTasks.has(taskId);
}

/** Clear the cancelled flag. Pipelines call this at entry so a retry can run. */
export function resetTaskCancellation(taskId: string): void {
  cancelledTasks.delete(taskId);
}

// --- Telegram ---

export type SendTelegram = (chatId: string, text: string) => Promise<void>;

/** Send a Telegram message. No-op if `chatId` is null; logs and swallows transport errors. */
export async function notifyTelegram(
  sendTelegram: SendTelegram,
  chatId: string | null,
  text: string,
): Promise<void> {
  if (!chatId) return;
  try {
    await sendTelegram(chatId, text);
  } catch (err) {
    log.warn(`Failed to send Telegram message: ${String(err)}`);
  }
}

// --- Task failure ---

/** Mark a task as failed: updates DB, emits SSE, notifies Telegram. Never throws. */
export async function failTask(
  taskId: string,
  error: string,
  sendTelegram: SendTelegram,
  chatId: string | null,
): Promise<void> {
  log.error(`Task ${taskId} failed: ${error}`);
  await queries.updateTask(taskId, { status: "failed", error });
  emit({ type: "task_update", taskId, status: "failed" });
  await notifyTelegram(sendTelegram, chatId, `Task failed: ${error}`);
}

/** Mark a task as complete and emit the terminal SSE update. */
export async function completeTask(taskId: string): Promise<void> {
  await queries.updateTask(taskId, { status: "complete", completedAt: new Date() });
  emit({ type: "task_update", taskId, status: "complete" });
}

// --- Timeout ---

export const STAGE_TIMEOUT_MS = 30 * 60 * 1000;

/** Race `promise` against a timer. Rejects with `${label} timed out ...` on expiry. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 60000}min`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

// --- Generic stage runner ---

interface RunStageOptions {
  taskId: string;
  stage: StageName;
  cwd: string;
  systemPrompt: string;
  initialPrompt: string;
  model: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
  stageLabel: string;
  /** Optional stage-run variant for parallel stages such as pr_impact. */
  variant?: number;
  /** Extensions to load via `-e`. Discovery stays disabled. */
  extensions?: string[];
  /** Extra env vars merged on top of `process.env` for the pi subprocess. */
  envOverrides?: Record<string, string>;
  /** Override the default 30-minute stage timeout. */
  timeoutMs?: number;
  /** Extra metadata attached to live `session_entry` SSE events for this stage. */
  sessionEventMeta?: {
    memoryRunId?: string;
  };
  /**
   * Runs after pi exits cleanly, before the stage row is marked complete.
   * A failed result persists/emits `failed`; throws behave like pi failures.
   */
  postValidate?: () => Promise<StageValidation>;
}

export type StageValidation<T = unknown> =
  | { valid: true; data?: T }
  | { valid: false; reason: string };

/**
 * Outcome of a stage. `ok: false` means the stage ran to completion but
 * postValidate rejected the output; the row is already persisted as failed
 * and the terminal SSE event was already emitted. A thrown pi-side failure
 * propagates instead and never produces a result value.
 */
export type StageResult<T = unknown> = { ok: true; data?: T } | { ok: false; reason: string };

/**
 * Run one pi-RPC stage end-to-end: mark task running, create the stage row,
 * spawn the pi subprocess with a persistent session file, tail that file to
 * SSE, then update the stage row on success/failure. The session is always
 * killed and the watcher always stopped in `finally`.
 */
export async function runStage<T = unknown>(
  options: Omit<RunStageOptions, "postValidate"> & { postValidate?: () => Promise<StageValidation<T>> },
): Promise<StageResult<T>> {
  const {
    taskId, stage, cwd, systemPrompt, initialPrompt,
    model, sendTelegram, chatId, stageLabel,
    variant, extensions, envOverrides, timeoutMs,
  } = options;

  const sessionPath = taskSessionPath(taskId, stage, variant);

  return withStageSpan(
    { taskId, stage, model, stageLabel, piSessionPath: sessionPath, variant },
    async (stageSpan): Promise<StageResult<T>> => {
      if (cancelledTasks.has(taskId)) {
        emit({ type: "stage_update", taskId, stage, variant, status: "skipped" });
        throw new TaskCancelledError(taskId);
      }

      const persisted = isPersistedTaskId(taskId);
      if (persisted) {
        await queries.updateTask(taskId, { status: "running" }).catch((err) => {
          log.warn(`updateTask failed for task ${taskId} (no matching tasks row?)`, err);
        });
      }
      emit({ type: "task_update", taskId, status: "running" });

      const stageRecord = persisted
        ? await queries.createTaskStage({ taskId, stage, variant }).catch((err) => {
            log.warn(`createTaskStage failed for task ${taskId} stage ${stage} (no matching tasks row?)`, err);
            return null;
          })
        : null;
      emit({ type: "stage_update", taskId, stage, variant, status: "running" });
      log.info(`Starting stage ${stage}${variant === undefined ? "" : ` v${variant}`} for task ${taskId}`);
      await notifyTelegram(sendTelegram, chatId, `Stage started: ${stageLabel}.`);

      await ensureSessionDir(sessionPath);
      const stopBroadcast = broadcastSessionFile(sessionPath, {
        scope: "task",
        taskId,
        stage,
        variant,
        memoryRunId: options.sessionEventMeta?.memoryRunId,
      });
      const stopBridge = bridgeSessionToOtel({
        sessionPath,
        stageSpan,
        taskId,
        initialModel: model,
      });

      const session = spawnPiSession({
        id: variant === undefined ? `${taskId}-${stage}` : `${taskId}-${stage}-v${variant}`,
        cwd,
        systemPrompt,
        model,
        sessionPath,
        extensions,
        envOverrides,
      });
      setActiveSession(taskId, stage, session, variant);
      session.sendPrompt(initialPrompt);

      try {
        await withTimeout(session.waitForCompletion(), timeoutMs ?? STAGE_TIMEOUT_MS, `Stage ${stage}`);
        const validation = await validateStageOutput(options.postValidate);
        if (!validation.valid) {
          await markStageTerminal(stageRecord?.id, taskId, stage, variant, "failed", validation.reason);
          log.warn(`Stage ${stage} failed postValidate for task ${taskId}: ${validation.reason}`);
          return { ok: false, reason: validation.reason };
        }

        await markStageTerminal(stageRecord?.id, taskId, stage, variant, "complete");
        await notifyTelegram(sendTelegram, chatId, `Stage complete: ${stageLabel}.`);
        log.info(`Stage ${stage} complete for task ${taskId}`);
        return { ok: true, ...(validation.data !== undefined ? { data: validation.data } : {}) };
      } catch (err) {
        const cancelled = cancelledTasks.has(taskId);
        const terminalStatus = cancelled ? "skipped" : "failed";
        await markStageTerminal(
          stageRecord?.id,
          taskId,
          stage,
          variant,
          terminalStatus,
          cancelled ? null : toErrorMessage(err),
        );
        if (cancelled) throw new TaskCancelledError(taskId);
        throw err;
      } finally {
        session.kill();
        await session.waitForExit();
        clearActiveSession(taskId, stage, variant);
        stopBridge();
        stopBroadcast();
      }
    },
  );
}

async function validateStageOutput<T>(
  postValidate: (() => Promise<StageValidation<T>>) | undefined,
): Promise<StageValidation<T>> {
  return postValidate ? postValidate() : { valid: true };
}

async function markStageTerminal(
  stageRecordId: string | undefined,
  taskId: string,
  stage: StageName,
  variant: number | undefined,
  status: "complete" | "failed" | "skipped",
  error?: string | null,
): Promise<void> {
  if (stageRecordId) {
    await queries.updateTaskStage(stageRecordId, {
      status,
      completedAt: new Date(),
      ...(status === "complete" ? {} : { error: error ?? null }),
    }).catch((err) => {
      log.warn(`updateTaskStage failed for task ${taskId} stage ${stage}`, err);
    });
  }
  emit({ type: "stage_update", taskId, stage, variant, status });
}
