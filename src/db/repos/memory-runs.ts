/**
 * Memory run repository methods.
 * Dashboard reads may include test-instance rows, writes stay exact-instance scoped.
 */

import { eq, desc, and, like } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import type { MemoryRun } from "../schema.js";
import type { MemoryRunKind, MemoryRunStatus, MemoryRunSource } from "../../shared/types.js";
import { TEST_INSTANCE_PREFIX } from "../../shared/test-instance.js";
import { instanceId, memoryRunsVisible } from "./scope.js";

// --- Memory Runs ---

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
