/**
 * Stage orchestration primitives shared by every pipeline: the active-session
 * registry (for cancellation), Telegram notification wrapper, task failure
 * helper, timeout combinator, and `runStage` — the generic pi-RPC subprocess
 * runner that powers every stage across every task kind.
 */

import { createLogger } from "../shared/logger.js";
import { emit } from "../shared/events.js";
import * as queries from "../db/queries.js";
import { spawnPiSession, type PiSession } from "./pi/session.js";
import { appendLogEntry, makeEntry, resetSeq } from "./logs.js";
import type { StageName, LogEntryKind, PiOutputMarker } from "../shared/types.js";

const log = createLogger("stage");

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
  /** Resume/create a persistent session file for this stage. */
  sessionPath?: string;
  /** Override the default 30-minute stage timeout. */
  timeoutMs?: number;
}

/**
 * Run one pi-RPC stage end-to-end: mark task running, create the stage row,
 * spawn the pi subprocess, stream logs, wait (bounded), then update the stage
 * row on success/failure. The session is always killed in `finally`, so
 * callers don't need to manage lifecycle.
 */
export async function runStage(options: RunStageOptions): Promise<{ marker: PiOutputMarker | null; fullOutput: string }> {
  const {
    taskId, stage, cwd, systemPrompt, initialPrompt,
    model, sendTelegram, chatId, stageLabel,
    extensions, envOverrides, sessionPath, timeoutMs,
  } = options;

  await queries.updateTask(taskId, { status: "running" });
  emit({ type: "task_update", taskId, status: "running" });

  const stageRecord = await queries.createTaskStage({ taskId, stage });
  emit({ type: "stage_update", taskId, stage, status: "running" });
  log.info(`Starting stage ${stage} for task ${taskId}`);
  await notifyTelegram(sendTelegram, chatId, `Stage started: ${stageLabel}.`);

  resetSeq(taskId, stage);
  const session = spawnPiSession({
    id: `${taskId}-${stage}`,
    cwd,
    systemPrompt,
    model,
    extensions,
    envOverrides,
    sessionPath,
    onLog: makeStageLogSink(taskId, stage),
  });
  setActiveSession(taskId, session);
  session.sendPrompt(initialPrompt);

  try {
    const result = await withTimeout(
      session.waitForCompletion(),
      timeoutMs ?? STAGE_TIMEOUT_MS,
      `Stage ${stage}`,
    );
    await queries.updateTaskStage(stageRecord.id, { status: "complete", completedAt: new Date() });
    emit({ type: "stage_update", taskId, stage, status: "complete" });
    await notifyTelegram(sendTelegram, chatId, `Stage complete: ${stageLabel}.`);
    log.info(`Stage ${stage} complete for task ${taskId}`);
    return result;
  } catch (err) {
    await queries.updateTaskStage(stageRecord.id, { status: "failed" }).catch(() => {});
    emit({ type: "stage_update", taskId, stage, status: "failed" });
    throw err;
  } finally {
    session.kill();
    await session.waitForExit();
    clearActiveSession(taskId);
  }
}

// --- Helpers ---

/** Build the `onLog` sink that emits SSE events and persists entries to the stage JSONL file. */
function makeStageLogSink(taskId: string, stage: StageName) {
  return (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => {
    const entry = makeEntry(taskId, stage, kind, text, meta);
    emit({ type: "log", taskId, stage, entry });
    appendLogEntry(taskId, stage, entry).catch((err) => {
      log.warn(`Failed to persist log entry: ${err}`);
    });
  };
}
