/**
 * Drizzle schema for Neon Postgres. Enum *values* are inlined here (rather
 * than imported from `shared/types.ts`) so `drizzle-kit` can load this file
 * without resolving ESM paths. The canonical TypeScript unions still live
 * in `shared/types.ts` and must stay in sync with the arrays below.
 */

import { pgTable, text, timestamp, integer, uuid, pgEnum, jsonb, index } from "drizzle-orm/pg-core";

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
  "answering", "pr_reviewing",
]);

export const prSessionStatusEnum = pgEnum("pr_session_status", [
  "active", "closed",
]);
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
  /** The coding task that originated this PR (null for external reviews) */
  originTaskId: uuid("origin_task_id").references(() => tasks.id),
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
  trigger: text("trigger").notNull(),       // "pr_creation" | "comments" | "external_review"
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

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
export type PrSession = typeof prSessions.$inferSelect;
export type PrSessionRun = typeof prSessionRuns.$inferSelect;
export type MemoryRun = typeof memoryRuns.$inferSelect;
