/**
 * Every DB read and write the app performs. All reads filter by
 * `instance = INSTANCE_ID` to isolate prod/dev. All writes use `.returning()`
 * so callers never have to issue a second select.
 */

import { eq, desc, and } from "drizzle-orm";
import { getDb, schema } from "./index.js";
import type { Task, TaskStage, PrSession, PrSessionRun } from "./schema.js";
import type { TaskStatus, TaskKind, StageStatus, StageName } from "../shared/types.js";
import { loadEnv } from "../shared/config.js";

export type { Task, TaskStage, PrSession, PrSessionRun };

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
      instance: loadEnv().INSTANCE_ID,
    })
    .returning();
  return task;
}

export async function getTask(id: string): Promise<Task | null> {
  const db = getDb();
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return task ?? null;
}

export async function listTasks(filters?: { status?: TaskStatus; repo?: string; kind?: TaskKind }): Promise<Task[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.instance, loadEnv().INSTANCE_ID),
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
    .where(eq(schema.tasks.id, id))
    .returning();
  return updated;
}

export async function findTaskByPrNumber(prNumber: number): Promise<Task | null> {
  const db = getDb();
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(and(
      eq(schema.tasks.instance, loadEnv().INSTANCE_ID),
      eq(schema.tasks.prNumber, prNumber),
    ));
  return task ?? null;
}

// --- Task Stages ---

export async function createTaskStage(data: {
  taskId: string;
  stage: StageName;
  piSessionId?: string;
}): Promise<TaskStage> {
  const db = getDb();
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
    .where(eq(schema.taskStages.id, id))
    .returning();
  return updated;
}

export async function getStagesForTask(taskId: string): Promise<TaskStage[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.taskStages)
    .where(eq(schema.taskStages.taskId, taskId))
    .orderBy(schema.taskStages.startedAt);
}

// --- PR Sessions ---

export async function createPrSession(data: {
  repo: string;
  prNumber?: number;
  branch?: string;
  worktreePath?: string;
  originTaskId?: string;
  telegramChatId: string;
}): Promise<PrSession> {
  const db = getDb();
  const [session] = await db
    .insert(schema.prSessions)
    .values({
      repo: data.repo,
      prNumber: data.prNumber ?? null,
      branch: data.branch ?? null,
      worktreePath: data.worktreePath ?? null,
      originTaskId: data.originTaskId ?? null,
      telegramChatId: data.telegramChatId,
      instance: loadEnv().INSTANCE_ID,
    })
    .returning();
  return session;
}

export async function getPrSession(id: string): Promise<PrSession | null> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(schema.prSessions)
    .where(eq(schema.prSessions.id, id));
  return session ?? null;
}

export async function listActivePrSessions(): Promise<PrSession[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.prSessions)
    .where(and(
      eq(schema.prSessions.instance, loadEnv().INSTANCE_ID),
      eq(schema.prSessions.status, "active"),
    ))
    .orderBy(desc(schema.prSessions.createdAt));
}

export async function listPrSessions(): Promise<PrSession[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.prSessions)
    .where(eq(schema.prSessions.instance, loadEnv().INSTANCE_ID))
    .orderBy(desc(schema.prSessions.createdAt));
}

export async function getPrSessionByOriginTask(originTaskId: string): Promise<PrSession | null> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(schema.prSessions)
    .where(eq(schema.prSessions.originTaskId, originTaskId));
  return session ?? null;
}

export async function updatePrSession(
  id: string,
  data: Partial<{
    status: "active" | "closed";
    prNumber: number;
    lastPolledAt: Date;
    worktreePath: string | null;
    branch: string | null;
  }>,
): Promise<PrSession | undefined> {
  const db = getDb();
  const [updated] = await db
    .update(schema.prSessions)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.prSessions.id, id))
    .returning();
  return updated;
}

// --- PR Session Runs ---

export async function createPrSessionRun(data: {
  prSessionId: string;
  trigger: string;
  comments?: unknown;
}): Promise<PrSessionRun> {
  const db = getDb();
  const [run] = await db
    .insert(schema.prSessionRuns)
    .values({
      prSessionId: data.prSessionId,
      trigger: data.trigger,
      comments: data.comments ?? null,
      status: "running",
    })
    .returning();
  return run;
}

export async function updatePrSessionRun(
  id: string,
  data: Partial<{
    status: string;
    error: string | null;
    completedAt: Date;
  }>,
): Promise<PrSessionRun | undefined> {
  const db = getDb();
  const [updated] = await db
    .update(schema.prSessionRuns)
    .set(data)
    .where(eq(schema.prSessionRuns.id, id))
    .returning();
  return updated;
}

export async function getRunsForPrSession(prSessionId: string): Promise<PrSessionRun[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.prSessionRuns)
    .where(eq(schema.prSessionRuns.prSessionId, prSessionId))
    .orderBy(schema.prSessionRuns.startedAt);
}
