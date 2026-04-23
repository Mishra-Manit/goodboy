/**
 * Stage orchestration primitives shared by every pipeline: the active-session
 * registry (for cancellation), Telegram notification wrapper, task-failure
 * helper, timeout combinator, and `runStage` -- the generic pi-RPC subprocess
 * runner that every task kind uses.
 *
 * Pi writes its own session JSONL to `sessionPath`; we tail it for SSE
 * broadcast, so this module doesn't touch logs directly.
 */

import { createLogger } from "../shared/logger.js";
import { emit } from "../shared/events.js";
import * as queries from "../db/repository.js";
import { spawnPiSession, type PiSession } from "./pi/spawn.js";
import { ensureSessionDir, taskSessionPath } from "./pi/session-file.js";
import { broadcastSessionFile } from "./pi/session-broadcast.js";
import { withStageSpan, bridgeSessionToOtel } from "../observability/index.js";
import type { StageName } from "../shared/types.js";

const log = createLogger("stage");

// --- Task identity ---

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `taskId` is a real `tasks.id` UUID (vs a manual-test label). */
export function isPersistedTaskId(taskId: string): boolean {
  return UUID_RE.test(taskId);
}

// --- Session registry ---

const activeSessions = new Map<string, PiSession>();

/** Register the live pi session for a task so cancellation can find it. */
export function setActiveSession(taskId: string, session: PiSession): void {
  activeSessions.set(taskId, session);
}

/** Drop the active session entry. Call once the stage finishes (success or failure). */
export function clearActiveSession(taskId: string): void {
  activeSessions.delete(taskId);
}

/** Kill the active pi session for a task. Returns `true` if one was running. */
export function cancelTask(taskId: string): boolean {
  const session = activeSessions.get(taskId);
  if (!session) return false;
  session.kill();
  activeSessions.delete(taskId);
  return true;
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
  /** Extensions to load via `-e`. Discovery stays disabled. */
  extensions?: string[];
  /** Extra env vars merged on top of `process.env` for the pi subprocess. */
  envOverrides?: Record<string, string>;
  /** Override the default 30-minute stage timeout. */
  timeoutMs?: number;
  /**
   * Runs after pi exits cleanly, before the stage row is marked complete
   * and before the terminal SSE emit. If it returns `{ valid: false }`,
   * the stage is persisted as failed with `error: reason` and exactly one
   * `stage_update: failed` is emitted (no prior `complete`). Throws from
   * postValidate bubble up and are handled like a pi-side failure.
   */
  postValidate?: () => Promise<{ valid: boolean; reason?: string }>;
}

/**
 * Run one pi-RPC stage end-to-end: mark task running, create the stage row,
 * spawn the pi subprocess with a persistent session file, tail that file to
 * SSE, then update the stage row on success/failure. The session is always
 * killed and the watcher always stopped in `finally`.
 */
export async function runStage(options: RunStageOptions): Promise<void> {
  const {
    taskId, stage, cwd, systemPrompt, initialPrompt,
    model, sendTelegram, chatId, stageLabel,
    extensions, envOverrides, timeoutMs,
  } = options;

  const sessionPath = taskSessionPath(taskId, stage);

  await withStageSpan(
    { taskId, stage, model, stageLabel, piSessionPath: sessionPath },
    async (stageSpan) => {
      const persisted = isPersistedTaskId(taskId);
      if (persisted) {
        await queries.updateTask(taskId, { status: "running" }).catch((err) => {
          log.warn(`updateTask failed for task ${taskId} (no matching tasks row?)`, err);
        });
      }
      emit({ type: "task_update", taskId, status: "running" });

      const stageRecord = persisted
        ? await queries.createTaskStage({ taskId, stage }).catch((err) => {
            log.warn(`createTaskStage failed for task ${taskId} stage ${stage} (no matching tasks row?)`, err);
            return null;
          })
        : null;
      emit({ type: "stage_update", taskId, stage, status: "running" });
      log.info(`Starting stage ${stage} for task ${taskId}`);
      await notifyTelegram(sendTelegram, chatId, `Stage started: ${stageLabel}.`);

      await ensureSessionDir(sessionPath);
      const stopBroadcast = broadcastSessionFile(sessionPath, { scope: "task", taskId, stage });
      const stopBridge = bridgeSessionToOtel({
        sessionPath,
        stageSpan,
        taskId,
        initialModel: model,
      });

      const session = spawnPiSession({
        id: `${taskId}-${stage}`,
        cwd,
        systemPrompt,
        model,
        sessionPath,
        extensions,
        envOverrides,
      });
      setActiveSession(taskId, session);
      session.sendPrompt(initialPrompt);

      try {
        await withTimeout(session.waitForCompletion(), timeoutMs ?? STAGE_TIMEOUT_MS, `Stage ${stage}`);
        if (options.postValidate) {
          const result = await options.postValidate();
          if (!result.valid) {
            const reason = result.reason ?? "postValidate failed";
            if (stageRecord) {
              await queries.updateTaskStage(stageRecord.id, {
                status: "failed", completedAt: new Date(), error: reason,
              }).catch(() => {});
            }
            emit({ type: "stage_update", taskId, stage, status: "failed" });
            log.warn(`Stage ${stage} failed postValidate for task ${taskId}: ${reason}`);
            return;
          }
        }
        if (stageRecord) {
          await queries.updateTaskStage(stageRecord.id, { status: "complete", completedAt: new Date() });
        }
        emit({ type: "stage_update", taskId, stage, status: "complete" });
        await notifyTelegram(sendTelegram, chatId, `Stage complete: ${stageLabel}.`);
        log.info(`Stage ${stage} complete for task ${taskId}`);
      } catch (err) {
        if (stageRecord) {
          await queries.updateTaskStage(stageRecord.id, { status: "failed" }).catch(() => {});
        }
        emit({ type: "stage_update", taskId, stage, status: "failed" });
        throw err;
      } finally {
        session.kill();
        await session.waitForExit();
        clearActiveSession(taskId);
        stopBridge();
        stopBroadcast();
      }
    },
  );
}
