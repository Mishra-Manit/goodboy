/** Idempotently backfill declared task artifacts and compact session metrics. */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { taskArtifactsDir } from "../src/shared/artifact-paths/index.js";
import { declaredArtifactsForStage } from "../src/shared/agent-output/declared-task-artifacts.js";
import { recordTaskArtifact } from "../src/core/artifacts/record.js";
import { readSessionFile, taskSessionPath } from "../src/core/pi/session-file.js";
import { summarizeSessionEntries } from "../src/core/pi/session-summary.js";
import { parseSubagentRuns } from "../src/core/subagents/session-parser.js";
import * as queries from "../src/db/repository.js";
import type { StageName, TaskKind } from "../src/shared/domain/types.js";

const dryRun = process.argv.includes("--dry-run");
const taskId = argValue("--task-id");

const DB_BACKED_STAGES: Partial<Record<TaskKind, readonly StageName[]>> = {
  coding_task: ["planner", "implementer", "reviewer"],
  codebase_question: ["answering"],
};

async function main(): Promise<void> {
  const tasks = taskId ? [await requiredTask(taskId)] : await queries.listTasks();
  let artifactCount = 0;
  let sessionCount = 0;

  for (const task of tasks) {
    process.stdout.write(`${dryRun ? "Checking" : "Backfilling"} ${task.id} (${task.kind})\n`);
    const stages = await queries.getStagesForTask(task.id);
    const artifactsDir = taskArtifactsDir(task.id);
    const stageRows = new Map(stages.map((stage) => [stage.stage, stage]));

    for (const stage of DB_BACKED_STAGES[task.kind] ?? []) {
      for (const artifact of declaredArtifactsForStage({ kind: task.kind, stage, artifactsDir })) {
        const contentText = await readFile(artifact.contract.path, "utf8").catch(() => null);
        if (!contentText) continue;
        artifactCount += 1;
        if (dryRun) continue;
        await recordTaskArtifact({
          taskId: task.id,
          taskKind: task.kind,
          stage,
          taskStageId: stageRows.get(stage)?.id ?? null,
          producerSessionId: null,
          artifactsDir,
          filePath: artifact.filePath,
          contentText,
        });
      }
    }

    for (const stage of stages) {
      const sessionPath = taskSessionPath(task.id, stage.stage, stage.variant ?? undefined);
      const entries = await readSessionFile(sessionPath);
      const summary = summarizeSessionEntries(entries);
      if (!summary) continue;
      sessionCount += 1;
      if (dryRun) continue;
      const agentSession = await queries.upsertAgentSession({
        taskStageId: stage.id,
        agentName: stage.stage,
        piSessionId: summary.piSessionId,
        sessionPath,
        model: summary.model,
        durationMs: summary.durationMs,
        totalTokens: summary.totalTokens,
        costUsd: summary.costUsd,
        toolCallCount: summary.toolCallCount,
      });
      await queries.attachProducerSessionToStageArtifacts(stage.id, agentSession.id);
      await Promise.all(parseSubagentRuns(entries).map((run) => (
        queries.upsertSubagentRun({ parentAgentSessionId: agentSession.id, ...run })
      )));
    }
  }

  process.stdout.write(`${dryRun ? "Would backfill" : "Backfilled"} ${artifactCount} artifacts and ${sessionCount} sessions\n`);
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

async function requiredTask(id: string): Promise<queries.Task> {
  const task = await queries.getTask(id);
  if (!task) throw new Error(`Task ${id} not found for this instance`);
  return task;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
