import { eq, desc, and, type SQL } from "drizzle-orm";
import { getDb, schema } from "./index.js";
import type { TaskStatus, StageStatus, StageName } from "../shared/types.js";

// --- Tasks ---

export async function createTask(data: {
  repo: string;
  description: string;
  telegramChatId: string;
}) {
  const db = getDb();
  const [task] = await db.insert(schema.tasks).values(data).returning();
  return task;
}

export async function getTask(id: string) {
  const db = getDb();
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
  return task ?? null;
}

export async function listTasks(filters?: { status?: TaskStatus; repo?: string }) {
  const db = getDb();
  const conditions: SQL[] = [];

  if (filters?.status) {
    conditions.push(eq(schema.tasks.status, filters.status));
  }
  if (filters?.repo) {
    conditions.push(eq(schema.tasks.repo, filters.repo));
  }

  const query = db
    .select()
    .from(schema.tasks)
    .orderBy(desc(schema.tasks.createdAt));

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
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
) {
  const db = getDb();
  const [updated] = await db
    .update(schema.tasks)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(schema.tasks.id, id))
    .returning();
  return updated;
}

export async function findTaskByPrNumber(prNumber: number) {
  const db = getDb();
  const [task] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.prNumber, prNumber));
  return task ?? null;
}

// --- Task Stages ---

export async function createTaskStage(data: {
  taskId: string;
  stage: string;
  piSessionId?: string;
}) {
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
) {
  const db = getDb();
  const [updated] = await db
    .update(schema.taskStages)
    .set(data)
    .where(eq(schema.taskStages.id, id))
    .returning();
  return updated;
}

export async function getStagesForTask(taskId: string) {
  const db = getDb();
  return db
    .select()
    .from(schema.taskStages)
    .where(eq(schema.taskStages.taskId, taskId))
    .orderBy(schema.taskStages.startedAt);
}

// --- Repos ---

export async function listRepos() {
  const db = getDb();
  return db.select().from(schema.repos);
}

export async function getRepo(name: string) {
  const db = getDb();
  const [repo] = await db.select().from(schema.repos).where(eq(schema.repos.name, name));
  return repo ?? null;
}

export async function upsertRepo(data: {
  name: string;
  localPath: string;
  githubUrl?: string;
}) {
  const db = getDb();
  const [repo] = await db
    .insert(schema.repos)
    .values(data)
    .onConflictDoUpdate({
      target: schema.repos.name,
      set: { localPath: data.localPath, githubUrl: data.githubUrl },
    })
    .returning();
  return repo;
}
