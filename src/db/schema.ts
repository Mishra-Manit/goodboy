/**
 * Drizzle schema for Neon Postgres. Enum *values* are inlined here (rather
 * than imported from `shared/types.ts`) so `drizzle-kit` can load this file
 * without resolving ESM paths. The canonical TypeScript unions still live
 * in `shared/types.ts` and must stay in sync with the arrays below.
 */

import { pgTable, text, timestamp, integer, uuid, pgEnum, jsonb } from "drizzle-orm/pg-core";

export const taskKindEnum = pgEnum("task_kind", [
  "coding_task", "codebase_question", "pr_review",
]);
export const taskStatusEnum = pgEnum("task_status", [
  "queued", "running", "complete", "failed", "cancelled",
]);
export const stageStatusEnum = pgEnum("stage_status", [
  "running", "complete", "failed",
]);
export const stageNameEnum = pgEnum("stage_name", [
  "planner", "implementer", "reviewer", "pr_creator", "revision",
  "answering", "pr_reviewing",
]);

export const prSessionStatusEnum = pgEnum("pr_session_status", [
  "active", "closed",
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

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
export type PrSession = typeof prSessions.$inferSelect;
export type PrSessionRun = typeof prSessionRuns.$inferSelect;
