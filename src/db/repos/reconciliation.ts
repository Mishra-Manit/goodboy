/**
 * Startup DB reconciliation for rows left running by a crashed process.
 * Only rows owned by the current INSTANCE_ID are reaped.
 */

import { eq, and, inArray } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import type { Task, TaskStage, MemoryRun } from "../schema.js";
import { instanceId } from "./scope.js";

// --- Startup Reconciliation ---

/**
 * Reap rows still marked `running` for this INSTANCE_ID. Called on boot:
 * if a row is `running` at startup, by definition the process that owned
 * it is gone (only one goodboy per INSTANCE_ID per the deploy contract).
 * Flips each orphan to a terminal state so the dashboard stops showing
 * "running" forever.
 *
 * Symmetric with `cleanupStaleMemoryLocks` on disk: lock files recover
 * filesystem state, this recovers DB state after the same unclean
 * shutdown.
 */
export async function reapRunningRows(
  reason = "server restarted while running",
): Promise<{
  tasks: Array<Pick<Task, "id" | "repo">>;
  stages: Array<Pick<TaskStage, "id" | "taskId" | "stage">>;
  memoryRuns: Array<Pick<MemoryRun, "id" | "repo" | "kind">>;
}> {
  const db = getDb();
  const instance = instanceId();
  const now = new Date();

  const reapedTasks = await db
    .update(schema.tasks)
    .set({ status: "failed", error: reason, completedAt: now, updatedAt: now })
    .where(and(
      eq(schema.tasks.instance, instance),
      eq(schema.tasks.status, "running"),
    ))
    .returning({ id: schema.tasks.id, repo: schema.tasks.repo });

  // task_stages has no instance column; scope by taskId joining tasks for
  // this instance is overkill because every task row is instance-scoped
  // and stage rows are only ever written alongside task rows. We update
  // any stage whose parent task belongs to this instance.
  const taskIdsForInstance = db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.instance, instance));

  const reapedStages = await db
    .update(schema.taskStages)
    .set({ status: "failed", error: reason, completedAt: now })
    .where(and(
      eq(schema.taskStages.status, "running"),
      inArray(schema.taskStages.taskId, taskIdsForInstance),
    ))
    .returning({
      id: schema.taskStages.id,
      taskId: schema.taskStages.taskId,
      stage: schema.taskStages.stage,
    });

  const reapedMemoryRuns = await db
    .update(schema.memoryRuns)
    .set({ status: "failed", error: reason, completedAt: now })
    .where(and(
      eq(schema.memoryRuns.instance, instance),
      eq(schema.memoryRuns.status, "running"),
    ))
    .returning({
      id: schema.memoryRuns.id,
      repo: schema.memoryRuns.repo,
      kind: schema.memoryRuns.kind,
    });

  return { tasks: reapedTasks, stages: reapedStages, memoryRuns: reapedMemoryRuns };
}
