/**
 * PR session repository methods and lifecycle transitions.
 * Session runs are scoped through their parent PR session row.
 */

import { eq, desc, and, inArray } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import type { PrSession, PrSessionRun } from "../schema.js";
import type { PrSessionMode, PrSessionWatchStatus } from "../../shared/domain/types.js";
import { instanceId, prSessionsForInstance } from "./scope.js";

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
