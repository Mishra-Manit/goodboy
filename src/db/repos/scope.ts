/**
 * Shared INSTANCE_ID predicates for repository modules.
 * Keeps child-table access scoped through parent rows that carry instance.
 */

import { and, eq, like, or } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import { loadEnv } from "../../shared/config.js";
import { TEST_INSTANCE_PREFIX } from "../../shared/test-instance.js";

/** Current runtime instance used to isolate dev/prod rows. */
export function instanceId(): string {
  return loadEnv().INSTANCE_ID;
}

/** Task ids visible to this INSTANCE_ID, for scoping child task-stage rows. */
export function tasksForInstance() {
  return getDb()
    .select({ id: schema.tasks.id })
    .from(schema.tasks)
    .where(eq(schema.tasks.instance, instanceId()));
}

/** PR session ids visible to this INSTANCE_ID, for scoping session-run rows. */
export function prSessionsForInstance() {
  return getDb()
    .select({ id: schema.prSessions.id })
    .from(schema.prSessions)
    .where(eq(schema.prSessions.instance, instanceId()));
}

/** Memory rows visible to dashboards and cleanup code. */
export function memoryRunsVisible(includeInactive = false) {
  const instanceVisible = or(
    eq(schema.memoryRuns.instance, instanceId()),
    like(schema.memoryRuns.instance, `${TEST_INSTANCE_PREFIX}%`),
  );

  return includeInactive
    ? instanceVisible
    : and(instanceVisible, eq(schema.memoryRuns.active, "TRUE"));
}
