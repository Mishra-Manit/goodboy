/**
 * Task and task-stage repository methods.
 * Stage rows inherit instance isolation from their parent task row.
 */

import { eq, desc, asc, and, inArray } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import type { Task, TaskStage } from "../schema.js";
import type { TaskStatus, TaskKind, StageStatus, StageName } from "../../shared/domain/types.js";
import { instanceId, tasksForInstance } from "./scope.js";

// --- Tasks ---

export async function createTask(data: {
  repo: string;
  kind: TaskKind;
  description: string;
  telegramChatId: string;
  prIdentifier?: string;
}): Promise<Task> {
  const db = getDb();
  const [task] = await db
    .insert(schema.tasks)
    .values({
      repo: data.repo,
      kind: data.kind,
      description: data.description,
      telegramChatId: data.telegramChatId,
      prIdentifier: data.prIdentifier ?? null,
      instance: instanceId(),
    })
    .returning();
  return task;
}

export async function getTask(id: string): Promise<Task | null> {
  const db = getDb();
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.id, id),
      eq(schema.tasks.instance, instanceId()),
    ));
  return task ?? null;
}

export async function listTasks(filters?: { status?: TaskStatus; repo?: string; kind?: TaskKind }): Promise<Task[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.instance, instanceId()),
      filters?.status ? eq(schema.tasks.status, filters.status) : undefined,
      filters?.repo ? eq(schema.tasks.repo, filters.repo) : undefined,
      filters?.kind ? eq(schema.tasks.kind, filters.kind) : undefined,
    ))
    .orderBy(desc(schema.tasks.createdAt));
}

export async function updateTask(
  id: string,
  data: Partial<{
    status: TaskStatus;
    branch: string | null;
    worktreePath: string | null;
    prUrl: string | null;
    prNumber: number | null;
    error: string | null;
    completedAt: Date | null;
  }>
): Promise<Task | undefined> {
  const db = getDb();
  const [updated] = await db
    .update(schema.tasks)
    .set({ ...data, updatedAt: new Date() })
    .where(and(
      eq(schema.tasks.id, id),
      eq(schema.tasks.instance, instanceId()),
    ))
    .returning();
  return updated;
}

export async function findTaskByPrNumber(prNumber: number): Promise<Task | null> {
  const db = getDb();
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.instance, instanceId()),
      eq(schema.tasks.prNumber, prNumber),
    ));
  return task ?? null;
}

// --- Task Stages ---

export async function createTaskStage(data: {
  taskId: string;
  stage: StageName;
  variant?: number;
  piSessionId?: string;
}): Promise<TaskStage> {
  const db = getDb();
  const [task] = await db
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.id, data.taskId),
      eq(schema.tasks.instance, instanceId()),
    ))
    .limit(1);
  if (!task) throw new Error(`Task ${data.taskId} not found for this instance`);

  const [stage] = await db.insert(schema.taskStages).values(data).returning();
  return stage;
}

export async function updateTaskStage(
  id: string,
  data: Partial<{
    status: StageStatus;
    completedAt: Date | null;
    piSessionId: string | null;
    error: string | null;
  }>
): Promise<TaskStage | undefined> {
  const db = getDb();
  const [updated] = await db
    .update(schema.taskStages)
    .set(data)
    .where(and(
      eq(schema.taskStages.id, id),
      inArray(schema.taskStages.taskId, tasksForInstance()),
    ))
    .returning();
  return updated;
}

export async function getStagesForTask(taskId: string): Promise<TaskStage[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.taskStages)
    .where(and(
      eq(schema.taskStages.taskId, taskId),
      inArray(schema.taskStages.taskId, tasksForInstance()),
    ))
    .orderBy(asc(schema.taskStages.startedAt), asc(schema.taskStages.variant));
}
