/**
 * Repository methods for declared DB-backed task artifacts.
 * Reads and writes scope through the parent task's instance row.
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import type { TaskArtifact } from "../schema.js";
import { instanceId, tasksForInstance } from "./scope.js";

// --- Writes ---

/** Upsert one declared artifact after validating ownership and content shape. */
export async function upsertTaskArtifact(data: {
  taskId: string;
  taskStageId: string | null;
  producerSessionId: string | null;
  filePath: string;
  contentText?: string;
  contentJson?: unknown;
  sha256: string;
}): Promise<TaskArtifact> {
  validateArtifactContent(data);
  await assertTaskInInstance(data.taskId);

  const content = artifactContentValues(data);
  const db = getDb();
  const [artifact] = await db
    .insert(schema.taskArtifacts)
    .values({
      taskId: data.taskId,
      taskStageId: data.taskStageId,
      producerSessionId: data.producerSessionId,
      filePath: data.filePath,
      sha256: data.sha256,
      ...content,
    })
    .onConflictDoUpdate({
      target: [schema.taskArtifacts.taskId, schema.taskArtifacts.filePath],
      set: {
        taskStageId: data.taskStageId,
        producerSessionId: data.producerSessionId,
        sha256: data.sha256,
        updatedAt: new Date(),
        ...content,
      },
    })
    .returning();
  return artifact;
}

/** Attach the parent pi session once it exists after stage completion. */
export async function attachProducerSessionToStageArtifacts(
  taskStageId: string,
  producerSessionId: string,
): Promise<number> {
  const db = getDb();
  const updated = await db
    .update(schema.taskArtifacts)
    .set({ producerSessionId, updatedAt: new Date() })
    .where(and(
      eq(schema.taskArtifacts.taskStageId, taskStageId),
      inArray(schema.taskArtifacts.taskId, tasksForInstance()),
    ))
    .returning({ id: schema.taskArtifacts.id });
  return updated.length;
}

// --- Reads ---

/** List declared artifacts for a task in stable path order. */
export async function listTaskArtifacts(taskId: string): Promise<TaskArtifact[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.taskArtifacts)
    .where(and(
      eq(schema.taskArtifacts.taskId, taskId),
      inArray(schema.taskArtifacts.taskId, tasksForInstance()),
    ))
    .orderBy(schema.taskArtifacts.filePath);
}

/** Get one declared artifact by task-relative file path. */
export async function getTaskArtifactByPath(taskId: string, filePath: string): Promise<TaskArtifact | null> {
  const db = getDb();
  const [artifact] = await db
    .select()
    .from(schema.taskArtifacts)
    .where(and(
      eq(schema.taskArtifacts.taskId, taskId),
      eq(schema.taskArtifacts.filePath, filePath),
      inArray(schema.taskArtifacts.taskId, tasksForInstance()),
    ));
  return artifact ?? null;
}

// --- Helpers ---

async function assertTaskInInstance(taskId: string): Promise<void> {
  const db = getDb();
  const [task] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), eq(schema.tasks.instance, instanceId())))
    .limit(1);
  if (!task) throw new Error(`Task ${taskId} not found for this instance`);
}

function validateArtifactContent(data: { contentText?: string; contentJson?: unknown }): void {
  const hasText = data.contentText !== undefined;
  const hasJson = data.contentJson !== undefined;
  if (hasText === hasJson) throw new Error("Task artifact must provide exactly one of contentText or contentJson");
}

function artifactContentValues(data: { contentText?: string; contentJson?: unknown }) {
  return data.contentText !== undefined
    ? { contentText: data.contentText, contentJson: null }
    : { contentText: null, contentJson: data.contentJson };
}
