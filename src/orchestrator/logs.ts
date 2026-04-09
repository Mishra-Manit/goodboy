import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../shared/config.js";
import type { LogEntry, LogEntryKind } from "../shared/types.js";

/** Per-stage sequence counters (taskId:stage -> next seq) */
const seqCounters = new Map<string, number>();

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

/**
 * Append a structured log entry to the stage JSONL file on disk.
 * Logs are stored at: artifacts/<taskId>/<stage>.jsonl
 */
export async function appendLogEntry(
  taskId: string,
  stage: string,
  entry: LogEntry
): Promise<void> {
  const dir = path.join(config.artifactsDir, taskId);
  await mkdir(dir, { recursive: true });
  const logPath = path.join(dir, `${stage}.jsonl`);
  await appendFile(logPath, JSON.stringify(entry) + "\n");
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
    return content
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as LogEntry);
  } catch {
    return [];
  }
}

/**
 * Read all logs for a task across all stages.
 */
export async function readTaskLogs(
  taskId: string
): Promise<Array<{ stage: string; entries: LogEntry[] }>> {
  const { readdir } = await import("node:fs/promises");
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
