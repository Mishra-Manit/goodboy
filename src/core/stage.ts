import { createLogger } from "../shared/logger.js";
import { emit } from "../shared/events.js";
import { config } from "../shared/config.js";
import * as queries from "../db/queries.js";
import { spawnPiSession, type PiSession } from "./pi/session.js";
import { appendLogEntry, makeEntry, resetSeq } from "./logs.js";
import type { StageName, LogEntryKind, PiOutputMarker } from "../shared/types.js";

const log = createLogger("stage");

// ---------------------------------------------------------------------------
// Session management
// ---------------------------------------------------------------------------

const activeSessions = new Map<string, PiSession>();

export function setActiveSession(taskId: string, session: PiSession): void {
  activeSessions.set(taskId, session);
}

export function clearActiveSession(taskId: string): void {
  activeSessions.delete(taskId);
}

export function cancelTask(taskId: string): boolean {
  const session = activeSessions.get(taskId);
  if (session) {
    session.kill();
    activeSessions.delete(taskId);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export type SendTelegram = (chatId: string, text: string) => Promise<void>;

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

// ---------------------------------------------------------------------------
// Task failure
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------------

export const STAGE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 60000}min`)), ms);
    }),
  ]).finally(() => clearTimeout(timer!));
}

// ---------------------------------------------------------------------------
// Generic stage runner
// ---------------------------------------------------------------------------

export async function runStage(options: {
  taskId: string;
  stage: StageName;
  cwd: string;
  systemPrompt: string;
  initialPrompt: string;
  model: string;
  sendTelegram: SendTelegram;
  chatId: string | null;
  stageLabel: string;
}): Promise<{ marker: PiOutputMarker | null; fullOutput: string }> {
  const {
    taskId, stage, cwd, systemPrompt, initialPrompt,
    model, sendTelegram, chatId, stageLabel,
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
    onLog: (kind: LogEntryKind, text: string, meta?: Record<string, unknown>) => {
      const entry = makeEntry(taskId, stage, kind, text, meta);
      emit({ type: "log", taskId, stage, entry });
      appendLogEntry(taskId, stage, entry).catch((err) => {
        log.warn(`Failed to persist log entry: ${err}`);
      });
    },
  });

  setActiveSession(taskId, session);
  session.sendPrompt(initialPrompt);

  try {
    const result = await withTimeout(
      session.waitForCompletion(),
      STAGE_TIMEOUT_MS,
      `Stage ${stage}`,
    );

    session.kill();
    await session.waitForExit();
    clearActiveSession(taskId);

    await queries.updateTaskStage(stageRecord.id, {
      status: "complete",
      completedAt: new Date(),
    });
    emit({ type: "stage_update", taskId, stage, status: "complete" });
    await notifyTelegram(sendTelegram, chatId, `Stage complete: ${stageLabel}.`);

    log.info(`Stage ${stage} complete for task ${taskId}`);
    return result;
  } catch (err) {
    session.kill();
    await session.waitForExit();
    clearActiveSession(taskId);
    await queries.updateTaskStage(stageRecord.id, { status: "failed" }).catch(() => {});
    emit({ type: "stage_update", taskId, stage, status: "failed" });
    throw err;
  }
}
