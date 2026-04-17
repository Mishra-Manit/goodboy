import { mkdir, appendFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../shared/config.js";
import type { LogEntry, LogEntryKind } from "../shared/types.js";

/** Per-stage sequence counters (taskId:stage -> next seq) */
const seqCounters = new Map<string, number>();
const writeQueues = new Map<string, Promise<void>>();

function nextSeq(taskId: string, stage: string): number {
  const key = `${taskId}:${stage}`;
  const seq = seqCounters.get(key) ?? 0;
  seqCounters.set(key, seq + 1);
  return seq;
}

/** Reset counter when a stage starts fresh (e.g. retry) */
export function resetSeq(taskId: string, stage: string): void {
  seqCounters.delete(`${taskId}:${stage}`);
}

/** Clean up all seq counters for a task (call in pipeline finally block) */
export function cleanupSeqCounters(taskId: string): void {
  for (const key of seqCounters.keys()) {
    if (key.startsWith(`${taskId}:`)) seqCounters.delete(key);
  }
}

/** Build a LogEntry with auto-incrementing seq */
export function makeEntry(
  taskId: string,
  stage: string,
  kind: LogEntryKind,
  text: string,
  meta?: Record<string, unknown>
): LogEntry {
  return {
    seq: nextSeq(taskId, stage),
    ts: new Date().toISOString(),
    kind,
    text,
    ...(meta ? { meta } : {}),
  };
}

function sortEntries(entries: LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => {
    const tsCompare = a.ts.localeCompare(b.ts);
    if (tsCompare !== 0) return tsCompare;
    return a.seq - b.seq;
  });
}

function enqueueWrite(queueKey: string, write: () => Promise<void>): Promise<void> {
  const previous = writeQueues.get(queueKey) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  writeQueues.set(queueKey, next);
  return next.finally(() => {
    if (writeQueues.get(queueKey) === next) {
      writeQueues.delete(queueKey);
    }
  });
}

/**
 * Append a structured log entry to the stage JSONL file on disk.
 * Logs are stored at: artifacts/<taskId>/<stage>.jsonl
 */
export async function appendLogEntry(
  taskId: string,
  stage: string,
  entry: LogEntry
): Promise<void> {
  const queueKey = `task:${taskId}:${stage}`;
  return enqueueWrite(queueKey, async () => {
    const dir = path.join(config.artifactsDir, taskId);
    await mkdir(dir, { recursive: true });
    const logPath = path.join(dir, `${stage}.jsonl`);
    await appendFile(logPath, JSON.stringify(entry) + "\n");
  });
}

/**
 * Read all structured log entries for a specific task stage.
 */
export async function readStageEntries(
  taskId: string,
  stage: string
): Promise<LogEntry[]> {
  const logPath = path.join(config.artifactsDir, taskId, `${stage}.jsonl`);
  try {
    const content = await readFile(logPath, "utf-8");
    return sortEntries(content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LogEntry));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// PR Session logs (stored at data/pr-sessions/<id>.log.jsonl)
// ---------------------------------------------------------------------------

export function makePrSessionEntry(
  prSessionId: string,
  kind: LogEntryKind,
  text: string,
  meta?: Record<string, unknown>,
  runId?: string,
): LogEntry {
  const entryMeta = { ...meta, ...(runId ? { runId } : {}) };
  return {
    seq: nextSeq(`pr:${prSessionId}`, "session"),
    ts: new Date().toISOString(),
    kind,
    text,
    ...(Object.keys(entryMeta).length > 0 ? { meta: entryMeta } : {}),
  };
}

export async function appendPrSessionLog(
  prSessionId: string,
  entry: LogEntry,
): Promise<void> {
  const queueKey = `pr:${prSessionId}`;
  return enqueueWrite(queueKey, async () => {
    const logPath = path.join(config.prSessionsDir, `${prSessionId}.log.jsonl`);
    await appendFile(logPath, JSON.stringify(entry) + "\n");
  });
}

export async function readPrSessionLog(
  prSessionId: string,
): Promise<LogEntry[]> {
  const logPath = path.join(config.prSessionsDir, `${prSessionId}.log.jsonl`);
  try {
    const content = await readFile(logPath, "utf-8");
    return sortEntries(content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LogEntry));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Task logs
// ---------------------------------------------------------------------------

/**
 * Read all logs for a task across all stages.
 */
export async function readTaskLogs(
  taskId: string
): Promise<Array<{ stage: string; entries: LogEntry[] }>> {
  const dir = path.join(config.artifactsDir, taskId);

  try {
    const files = await readdir(dir);
    const logFiles = files.filter((f) => f.endsWith(".jsonl"));

    const results: Array<{ stage: string; entries: LogEntry[] }> = [];
    for (const file of logFiles) {
      const stage = file.replace(".jsonl", "");
      const entries = await readStageEntries(taskId, stage);
      results.push({ stage, entries });
    }
    return results;
  } catch {
    return [];
  }
}
