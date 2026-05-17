/**
 * Repository methods for compact parent agent sessions and delegated subagent runs.
 * Ownership is scoped through task stages, PR session runs, or memory runs.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "../index.js";
import type { AgentSession, SubagentRun } from "../schema.js";
import { prSessionsForInstance, tasksForInstance } from "./scope.js";

export type SubagentRunStatus = "running" | "complete" | "failed";

// --- Agent Sessions ---

/** Upsert compact metrics for one pi JSONL session. */
export async function upsertAgentSession(data: {
  taskStageId?: string | null;
  prSessionRunId?: string | null;
  memoryRunId?: string | null;
  agentName: string;
  piSessionId: string;
  sessionPath: string;
  model?: string | null;
  durationMs?: number | null;
  totalTokens?: number | null;
  costUsd?: string | null;
  toolCallCount?: number | null;
}): Promise<AgentSession> {
  validateAgentSessionOwner(data);
  const db = getDb();
  const values = agentSessionValues(data);
  const [session] = await db
    .insert(schema.agentSessions)
    .values(values)
    .onConflictDoUpdate({
      target: schema.agentSessions.piSessionId,
      set: values,
    })
    .returning();
  return session;
}

/** List parent agent sessions attached to stages for a task. */
export async function listAgentSessionsForTask(taskId: string): Promise<AgentSession[]> {
  const db = getDb();
  return db
    .select({ session: schema.agentSessions })
    .from(schema.agentSessions)
    .innerJoin(schema.taskStages, eq(schema.agentSessions.taskStageId, schema.taskStages.id))
    .where(and(
      eq(schema.taskStages.taskId, taskId),
      inArray(schema.taskStages.taskId, tasksForInstance()),
    ))
    .orderBy(asc(schema.taskStages.startedAt))
    .then((rows) => rows.map((row) => row.session));
}

/** List parent agent sessions created by runs for one PR session. */
export async function listAgentSessionsForPrSession(prSessionId: string): Promise<AgentSession[]> {
  const db = getDb();
  return db
    .select({ session: schema.agentSessions })
    .from(schema.agentSessions)
    .innerJoin(schema.prSessionRuns, eq(schema.agentSessions.prSessionRunId, schema.prSessionRuns.id))
    .where(and(
      eq(schema.prSessionRuns.prSessionId, prSessionId),
      inArray(schema.prSessionRuns.prSessionId, prSessionsForInstance()),
    ))
    .orderBy(asc(schema.prSessionRuns.startedAt))
    .then((rows) => rows.map((row) => row.session));
}

// --- Subagent Runs ---

/** Upsert one delegated subagent run observed from the parent session. */
export async function upsertSubagentRun(data: {
  parentAgentSessionId: string;
  agentName: string;
  runIndex: number | null;
  prompt: string;
  resultText?: string | null;
  status: SubagentRunStatus;
  model?: string | null;
  durationMs?: number | null;
  totalTokens?: number | null;
  costUsd?: string | null;
  toolCallCount?: number | null;
}): Promise<SubagentRun> {
  const db = getDb();
  const values = subagentRunValues(data);
  if (data.runIndex === null) {
    const [run] = await db.insert(schema.subagentRuns).values(values).returning();
    return run;
  }

  const [run] = await db
    .insert(schema.subagentRuns)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.subagentRuns.parentAgentSessionId, schema.subagentRuns.runIndex],
      set: values,
    })
    .returning();
  return run;
}

/** List subagent runs for a parent session in call order. */
export async function listSubagentRunsForAgentSession(agentSessionId: string): Promise<SubagentRun[]> {
  const db = getDb();
  return db
    .select()
    .from(schema.subagentRuns)
    .where(eq(schema.subagentRuns.parentAgentSessionId, agentSessionId))
    .orderBy(asc(schema.subagentRuns.runIndex));
}

// --- Helpers ---

function validateAgentSessionOwner(data: {
  taskStageId?: string | null;
  prSessionRunId?: string | null;
  memoryRunId?: string | null;
}): void {
  const ownerCount = [data.taskStageId, data.prSessionRunId, data.memoryRunId].filter(Boolean).length;
  if (ownerCount !== 1) throw new Error("Agent session must have exactly one owner");
}

function agentSessionValues(data: {
  taskStageId?: string | null;
  prSessionRunId?: string | null;
  memoryRunId?: string | null;
  agentName: string;
  piSessionId: string;
  sessionPath: string;
  model?: string | null;
  durationMs?: number | null;
  totalTokens?: number | null;
  costUsd?: string | null;
  toolCallCount?: number | null;
}) {
  return {
    taskStageId: data.taskStageId ?? null,
    prSessionRunId: data.prSessionRunId ?? null,
    memoryRunId: data.memoryRunId ?? null,
    agentName: data.agentName,
    piSessionId: data.piSessionId,
    sessionPath: data.sessionPath,
    model: data.model ?? null,
    durationMs: data.durationMs ?? null,
    totalTokens: data.totalTokens ?? null,
    costUsd: data.costUsd ?? null,
    toolCallCount: data.toolCallCount ?? null,
  };
}

function subagentRunValues(data: {
  parentAgentSessionId: string;
  agentName: string;
  runIndex: number | null;
  prompt: string;
  resultText?: string | null;
  status: SubagentRunStatus;
  model?: string | null;
  durationMs?: number | null;
  totalTokens?: number | null;
  costUsd?: string | null;
  toolCallCount?: number | null;
}) {
  return {
    parentAgentSessionId: data.parentAgentSessionId,
    agentName: data.agentName,
    runIndex: data.runIndex,
    prompt: data.prompt,
    resultText: data.resultText ?? null,
    status: data.status,
    model: data.model ?? null,
    durationMs: data.durationMs ?? null,
    totalTokens: data.totalTokens ?? null,
    costUsd: data.costUsd ?? null,
    toolCallCount: data.toolCallCount ?? null,
  };
}
