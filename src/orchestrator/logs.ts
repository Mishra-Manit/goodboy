import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../shared/config.js";

/**
 * Append a log line to the stage log file on disk.
 * Logs are stored at: artifacts/<taskId>/<stage>.log
 */
export async function appendLogLine(
  taskId: string,
  stage: string,
  line: string
): Promise<void> {
  const dir = path.join(config.artifactsDir, taskId);
  await mkdir(dir, { recursive: true });
  const logPath = path.join(dir, `${stage}.log`);
  await appendFile(logPath, line + "\n");
}

/**
 * Read all log lines for a specific task stage.
 */
export async function readStageLogs(
  taskId: string,
  stage: string
): Promise<string[]> {
  const logPath = path.join(config.artifactsDir, taskId, `${stage}.log`);
  try {
    const content = await readFile(logPath, "utf-8");
    return content.split("\n").filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

/**
 * Read all logs for a task across all stages.
 */
export async function readTaskLogs(
  taskId: string
): Promise<Array<{ stage: string; lines: string[] }>> {
  const { readdir } = await import("node:fs/promises");
  const dir = path.join(config.artifactsDir, taskId);

  try {
    const files = await readdir(dir);
    const logFiles = files.filter((f) => f.endsWith(".log"));

    const results: Array<{ stage: string; lines: string[] }> = [];
    for (const file of logFiles) {
      const stage = file.replace(".log", "");
      const lines = await readStageLogs(taskId, stage);
      results.push({ stage, lines });
    }
    return results;
  } catch {
    return [];
  }
}
