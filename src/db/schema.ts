/**
 * Drizzle schema for Neon Postgres. Enum *values* are inlined here (rather
 * than imported from `shared/domain/types.ts`) so `drizzle-kit` can load this file
 * without resolving ESM paths. The canonical TypeScript unions still live
 * in `shared/domain/types.ts` and must stay in sync with the arrays below.
 */

import {
  pgTable,
  text,
  timestamp,
  integer,
  uuid,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
  numeric,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const taskKindEnum = pgEnum("task_kind", [
  "coding_task", "codebase_question", "pr_review",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "queued", "running", "complete", "failed", "cancelled",
]);
export const stageStatusEnum = pgEnum("stage_status", [
  "running", "complete", "failed", "skipped",
]);
export const stageNameEnum = pgEnum("stage_name", [
  "memory",
  "planner", "implementer", "reviewer", "pr_creator", "revision",
  "answering", "pr_impact", "pr_analyst", "pr_finalizer",
]);

export const prSessionStatusEnum = pgEnum("pr_session_status", [
  "active", "closed",
]);
export const prSessionWatchStatusEnum = pgEnum("pr_session_watch_status", [
  "watching", "muted",
]);
export const prSessionModeEnum = pgEnum("pr_session_mode", ["own", "review"]);
/**
 * Memory run kinds. `cold` and `warm` spawn a pi session and produce a
 * transcript; `skip` (lock held) and `noop` (repo up-to-date) are no-op
 * outcomes recorded purely so the dashboard can show "memory was checked."
 * No-op kinds always start and finish in the same atomic write -- their
 * rows never appear with status=running.
 */
export const memoryRunKindEnum = pgEnum("memory_run_kind", [
  "cold", "warm", "skip", "noop",
]);
export const memoryRunStatusEnum = pgEnum("memory_run_status", [
  "running", "complete", "failed",
]);
export const memoryRunSourceEnum = pgEnum("memory_run_source", [
  "task", "manual_test",
]);
export const memoryRunActiveEnum = pgEnum("memory_run_active", [
  "TRUE", "FALSE",
]);
export const subagentRunStatusEnum = pgEnum("subagent_run_status", [
  "running", "complete", "failed",
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  kind: taskKindEnum("kind").notNull().default("coding_task"),
  description: text("description").notNull(),
  status: taskStatusEnum("status").notNull().default("queued"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  prIdentifier: text("pr_identifier"),
  error: text("error"),
  instance: text("instance").notNull(),
  telegramChatId: text("telegram_chat_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const taskStages = pgTable("task_stages", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id")
    .notNull()
    .references(() => tasks.id),
  stage: stageNameEnum("stage").notNull(),
  variant: integer("variant"),
  status: stageStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  piSessionId: text("pi_session_id"),
  error: text("error"),
});

export const prSessions = pgTable("pr_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  prNumber: integer("pr_number"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  status: prSessionStatusEnum("status").notNull().default("active"),
  watchStatus: prSessionWatchStatusEnum("watch_status").notNull().default("watching"),
  /** Lifecycle mode: own = goodboy created the PR, review = external PR being reviewed. */
  mode: prSessionModeEnum("mode").notNull(),
  /** The task that produced this session (coding_task for own, pr_review for review). */
  sourceTaskId: uuid("source_task_id").references(() => tasks.id),
  /** Telegram chat ID for notifications */
  telegramChatId: text("telegram_chat_id"),
  /** Timestamp of last poll cycle (used to detect new comments) */
  lastPolledAt: timestamp("last_polled_at"),
  instance: text("instance").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const prSessionRuns = pgTable("pr_session_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  prSessionId: uuid("pr_session_id")
    .notNull()
    .references(() => prSessions.id),
  trigger: text("trigger").notNull(),       // "pr_creation" | "comments"
  comments: jsonb("comments"),               // PrComment[] that triggered this run, null for non-comment triggers
  status: text("status").notNull(),          // "running" | "complete" | "failed"
  error: text("error"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

/**
 * One row per memory pipeline invocation. Duplicates some fields with
 * `task_stages` (status, startedAt, completedAt, error) because a memory run
 * is both a stage inside a task AND a first-class memory-specific event with
 * its own lifecycle:
 *   - `task_stages` gives the coding/question task a uniform cross-stage
 *     history entry, owned by `runStage` for cold/warm and by
 *     `finalizeInlineMemoryStage` for skip/noop.
 *   - `memory_runs` holds memory-specific detail (kind, sha, zoneCount,
 *     externalLabel for manual-test runs) and per-repo history queries.
 * Keep both in sync via `MemoryRunTracker` + `finalizeInlineMemoryStage`.
 */
export const memoryRuns = pgTable("memory_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  instance: text("instance").notNull(),
  repo: text("repo").notNull(),
  source: memoryRunSourceEnum("source").notNull(),
  kind: memoryRunKindEnum("kind").notNull(),
  status: memoryRunStatusEnum("status").notNull().default("running"),
  active: memoryRunActiveEnum("active").notNull().default("TRUE"),
  originTaskId: uuid("origin_task_id").references(() => tasks.id),
  externalLabel: text("external_label"),
  sha: text("sha"),
  zoneCount: integer("zone_count"),
  error: text("error"),
  sessionPath: text("session_path"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
}, (table) => ({
  repoStartedAtIdx: index("memory_runs_repo_started_at_idx").on(table.repo, table.startedAt),
  instanceStartedAtIdx: index("memory_runs_instance_started_at_idx").on(table.instance, table.startedAt),
  repoKindStartedAtIdx: index("memory_runs_repo_kind_started_at_idx").on(table.repo, table.kind, table.startedAt),
  repoActiveStartedAtIdx: index("memory_runs_repo_active_started_at_idx").on(table.repo, table.active, table.startedAt),
}));

export const agentSessions = pgTable("agent_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskStageId: uuid("task_stage_id").references(() => taskStages.id),
  prSessionRunId: uuid("pr_session_run_id").references(() => prSessionRuns.id),
  memoryRunId: uuid("memory_run_id").references(() => memoryRuns.id),
  agentName: text("agent_name").notNull(),
  piSessionId: text("pi_session_id").notNull(),
  sessionPath: text("session_path").notNull(),
  model: text("model"),
  durationMs: integer("duration_ms"),
  totalTokens: integer("total_tokens"),
  costUsd: numeric("cost_usd"),
  toolCallCount: integer("tool_call_count"),
}, (table) => ({
  piSessionIdUniqueIdx: uniqueIndex("agent_sessions_pi_session_id_unique_idx").on(table.piSessionId),
  taskStageIdx: index("agent_sessions_task_stage_idx").on(table.taskStageId),
  prSessionRunIdx: index("agent_sessions_pr_session_run_idx").on(table.prSessionRunId),
  memoryRunIdx: index("agent_sessions_memory_run_idx").on(table.memoryRunId),
  ownerCheck: check(
    "agent_sessions_one_owner_check",
    sql`((task_stage_id is not null)::int + (pr_session_run_id is not null)::int + (memory_run_id is not null)::int) = 1`,
  ),
}));

export const taskArtifacts = pgTable("task_artifacts", {
  id: uuid("id").primaryKey().defaultRandom(),
  taskId: uuid("task_id").notNull().references(() => tasks.id),
  taskStageId: uuid("task_stage_id").references(() => taskStages.id),
  producerSessionId: uuid("producer_session_id").references(() => agentSessions.id),
  filePath: text("file_path").notNull(),
  contentText: text("content_text"),
  contentJson: jsonb("content_json"),
  sha256: text("sha256").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  taskFileUniqueIdx: uniqueIndex("task_artifacts_task_file_unique_idx").on(table.taskId, table.filePath),
  taskStageIdx: index("task_artifacts_task_stage_idx").on(table.taskStageId),
  producerSessionIdx: index("task_artifacts_producer_session_idx").on(table.producerSessionId),
  contentCheck: check(
    "task_artifacts_one_content_check",
    sql`(content_text is not null and content_json is null) or (content_text is null and content_json is not null)`,
  ),
}));

export const subagentRuns = pgTable("subagent_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  parentAgentSessionId: uuid("parent_agent_session_id").notNull().references(() => agentSessions.id),
  agentName: text("agent_name").notNull(),
  runIndex: integer("run_index"),
  prompt: text("prompt").notNull(),
  resultText: text("result_text"),
  status: subagentRunStatusEnum("status").notNull(),
  model: text("model"),
  durationMs: integer("duration_ms"),
  totalTokens: integer("total_tokens"),
  costUsd: numeric("cost_usd"),
  toolCallCount: integer("tool_call_count"),
}, (table) => ({
  parentRunIdx: uniqueIndex("subagent_runs_parent_index_unique_idx").on(table.parentAgentSessionId, table.runIndex),
}));

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
export type PrSession = typeof prSessions.$inferSelect;
export type PrSessionRun = typeof prSessionRuns.$inferSelect;
export type MemoryRun = typeof memoryRuns.$inferSelect;
export type AgentSession = typeof agentSessions.$inferSelect;
export type TaskArtifact = typeof taskArtifacts.$inferSelect;
export type SubagentRun = typeof subagentRuns.$inferSelect;
