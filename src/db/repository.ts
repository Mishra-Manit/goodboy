/**
 * Every DB read and write the app performs. All reads filter by
 * `instance = INSTANCE_ID` to isolate prod/dev. All writes use `.returning()`
 * so callers never have to issue a second select.
 */

import { eq, desc, asc, and, or, like, inArray } from "drizzle-orm";
import { getDb, schema } from "./index.js";
import type { Task, TaskStage, PrSession, PrSessionRun, MemoryRun } from "./schema.js";
import type {
  TaskStatus,
  TaskKind,
  StageStatus,
  StageName,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
  PrSessionWatchStatus,
  PrSessionMode,
} from "../shared/types.js";
import { loadEnv } from "../shared/config.js";
import { TEST_INSTANCE_PREFIX } from "../shared/test-instance.js";

export type { Task, TaskStage, PrSession, PrSessionRun, MemoryRun };

// --- Helpers ---

function instanceId(): string {
  return loadEnv().INSTANCE_ID;
}

function tasksForInstance() {
  return getDb()
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.instance, instanceId()));
}

function prSessionsForInstance() {
  return getDb()
    .select({ id: schema.prSessions.id })
    .from(schema.prSessions)
    .where(eq(schema.prSessions.instance, instanceId()));
}

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

// --- PR Sessions ---

export async function createPrSession(data: {
  repo: string;
  prNumber?: number;
  branch?: string;
  worktreePath?: string;
  mode: PrSessionMode;
  sourceTaskId?: string;
  telegramChatId: string | null;
}): Promise<PrSession> {
  const db = getDb();
  const [session] = await db
    .insert(schema.prSessions)
    .values({
      repo: data.repo,
      prNumber: data.prNumber ?? null,
      branch: data.branch ?? null,
      worktreePath: data.worktreePath ?? null,
      mode: data.mode,
      sourceTaskId: data.sourceTaskId ?? null,
      telegramChatId: data.telegramChatId,
      instance: instanceId(),
    })
    .returning();
  return session;
}

/** Create a PR session and atomically move branch/worktree ownership off the task row. */
export async function createPrSessionAndTransferTaskOwnership(data: {
  repo: string;
  prNumber?: number;
  branch: string;
  worktreePath: string;
  mode: PrSessionMode;
  sourceTaskId: string;
  telegramChatId: string | null;
  lastPolledAt?: Date;
}): Promise<PrSession> {
  const db = getDb();
  const instance = instanceId();

  return db.transaction(async (tx) => {
    const [session] = await tx
      .insert(schema.prSessions)
      .values({
        repo: data.repo,
        prNumber: data.prNumber ?? null,
        branch: data.branch,
        worktreePath: data.worktreePath,
        mode: data.mode,
        sourceTaskId: data.sourceTaskId,
        telegramChatId: data.telegramChatId,
        lastPolledAt: data.lastPolledAt ?? null,
        instance,
      })
      .returning();

    const [task] = await tx
      .update(schema.tasks)
      .set({ branch: null, worktreePath: null, updatedAt: new Date() })
      .where(and(
        eq(schema.tasks.id, data.sourceTaskId),
        eq(schema.tasks.instance, instance),
      ))
      .returning({ id: schema.tasks.id });

    if (!task) throw new Error(`Task ${data.sourceTaskId} not found for this instance`);
    return session;
  });
}

export async function getPrSession(id: string): Promise<PrSession | null> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(schema.prSessions)
    .where(and(
      eq(schema.prSessions.id, id),
      eq(schema.prSessions.instance, instanceId()),
    ));
  return session ?? null;
}

export async function listActivePrSessions(): Promise<PrSession[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.prSessions)
    .where(and(
      eq(schema.prSessions.instance, instanceId()),
      eq(schema.prSessions.status, "active"),
    ))
    .orderBy(desc(schema.prSessions.createdAt));
}

export async function listPrSessions(): Promise<PrSession[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.prSessions)
    .where(eq(schema.prSessions.instance, instanceId()))
    .orderBy(desc(schema.prSessions.createdAt));
}

export async function getPrSessionBySourceTask(sourceTaskId: string): Promise<PrSession | null> {
  const db = getDb();
  const [session] = await db
    .select()
    .from(schema.prSessions)
    .where(and(
      eq(schema.prSessions.sourceTaskId, sourceTaskId),
      eq(schema.prSessions.instance, instanceId()),
    ));
  return session ?? null;
}

export async function updatePrSession(
  id: string,
  data: Partial<{
    status: "active" | "closed";
    watchStatus: PrSessionWatchStatus;
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
    .where(and(
      eq(schema.prSessions.id, id),
      eq(schema.prSessions.instance, instanceId()),
    ))
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
  const [session] = await db
    .select({ id: schema.prSessions.id })
    .from(schema.prSessions)
    .where(and(
      eq(schema.prSessions.id, data.prSessionId),
      eq(schema.prSessions.instance, instanceId()),
    ))
    .limit(1);
  if (!session) throw new Error(`PR session ${data.prSessionId} not found for this instance`);

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
    .where(and(
      eq(schema.prSessionRuns.id, id),
      inArray(schema.prSessionRuns.prSessionId, prSessionsForInstance()),
    ))
    .returning();
  return updated;
}

/** Mark a PR session run complete through the instance-scoped write path. */
export async function completePrSessionRun(id: string): Promise<PrSessionRun | undefined> {
  return updatePrSessionRun(id, { status: "complete", completedAt: new Date() });
}

/** Mark a PR session run failed through the instance-scoped write path. */
export async function failPrSessionRun(id: string, error: string): Promise<PrSessionRun | undefined> {
  return updatePrSessionRun(id, { status: "failed", error, completedAt: new Date() });
}

export async function getRunsForPrSession(prSessionId: string): Promise<PrSessionRun[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.prSessionRuns)
    .where(and(
      eq(schema.prSessionRuns.prSessionId, prSessionId),
      inArray(schema.prSessionRuns.prSessionId, prSessionsForInstance()),
    ))
    .orderBy(schema.prSessionRuns.startedAt);
}

/** Newest still-running run for a session, or null. Used as a busy guard. */
export async function getRunningPrSessionRun(prSessionId: string): Promise<PrSessionRun | null> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(schema.prSessionRuns)
    .where(and(
      eq(schema.prSessionRuns.prSessionId, prSessionId),
      inArray(schema.prSessionRuns.prSessionId, prSessionsForInstance()),
      eq(schema.prSessionRuns.status, "running"),
    ))
    .orderBy(desc(schema.prSessionRuns.startedAt))
    .limit(1);
  return run ?? null;
}

// --- Memory Runs ---

function memoryRunsVisible(includeInactive = false) {
  const instanceVisible = or(
    eq(schema.memoryRuns.instance, instanceId()),
    like(schema.memoryRuns.instance, `${TEST_INSTANCE_PREFIX}%`),
  );

  return includeInactive
    ? instanceVisible
    : and(instanceVisible, eq(schema.memoryRuns.active, "TRUE"));
}

export async function createMemoryRun(data: {
  instance: string;
  repo: string;
  source: MemoryRunSource;
  kind: MemoryRunKind;
  originTaskId: string | null;
  externalLabel: string | null;
  sessionPath: string | null;
}): Promise<MemoryRun> {
  const db = getDb();
  const [run] = await db
    .insert(schema.memoryRuns)
    .values({
      ...data,
      status: "running",
      // Match completedAt's clock; defaultNow() runs on Neon and drifts vs EC2.
      startedAt: new Date(),
    })
    .returning();
  return run;
}

export async function updateMemoryRun(
  id: string,
  data: Partial<{
    status: MemoryRunStatus;
    sha: string | null;
    zoneCount: number | null;
    error: string | null;
    completedAt: Date | null;
  }>,
): Promise<MemoryRun | undefined> {
  const db = getDb();
  const [run] = await db
    .update(schema.memoryRuns)
    .set(data)
    .where(and(
      eq(schema.memoryRuns.id, id),
      eq(schema.memoryRuns.instance, instanceId()),
    ))
    .returning();
  return run;
}

export async function listMemoryRuns(filters: {
  repo?: string;
  limit?: number;
  kind?: MemoryRunKind;
  includeTests?: boolean;
  includeInactive?: boolean;
} = {}): Promise<MemoryRun[]> {
  const instanceVisibility = filters.includeTests === false
    ? eq(schema.memoryRuns.instance, instanceId())
    : memoryRunsVisible(true);
  const visibility = filters.includeInactive
    ? instanceVisibility
    : and(instanceVisibility, eq(schema.memoryRuns.active, "TRUE"));

  const db = getDb();
  const query = db
    .select()
    .from(schema.memoryRuns)
    .where(and(
      visibility,
      filters.repo ? eq(schema.memoryRuns.repo, filters.repo) : undefined,
      filters.kind ? eq(schema.memoryRuns.kind, filters.kind) : undefined,
    ))
    .orderBy(desc(schema.memoryRuns.startedAt));

  return filters.limit === undefined ? query : query.limit(filters.limit);
}

export async function getMemoryRun(
  id: string,
  options: { includeInactive?: boolean } = {},
): Promise<MemoryRun | undefined> {
  const db = getDb();
  const [run] = await db
    .select()
    .from(schema.memoryRuns)
    .where(and(eq(schema.memoryRuns.id, id), memoryRunsVisible(options.includeInactive)))
    .limit(1);
  return run;
}

export async function deactivateMemoryRunsForRepo(repo: string): Promise<number> {
  const db = getDb();
  const rows = await db
    .update(schema.memoryRuns)
    .set({ active: "FALSE" })
    .where(and(
      eq(schema.memoryRuns.repo, repo),
      eq(schema.memoryRuns.instance, instanceId()),
      eq(schema.memoryRuns.active, "TRUE"),
    ))
    .returning({ id: schema.memoryRuns.id });

  return rows.length;
}

export async function deleteTestMemoryRuns(): Promise<Array<Pick<MemoryRun, "id" | "sessionPath">>> {
  const db = getDb();
  return db
    .delete(schema.memoryRuns)
    .where(like(schema.memoryRuns.instance, `${TEST_INSTANCE_PREFIX}%`))
    .returning({
      id: schema.memoryRuns.id,
      sessionPath: schema.memoryRuns.sessionPath,
    });
}

// --- Startup reconciliation ---

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
