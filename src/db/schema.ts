import { pgTable, text, timestamp, integer, uuid, pgEnum } from "drizzle-orm/pg-core";
import { TASK_STATUSES, STAGE_STATUSES, STAGE_NAMES } from "../shared/types.js";

export const taskStatusEnum = pgEnum("task_status", [...TASK_STATUSES] as [string, ...string[]]);
export const stageStatusEnum = pgEnum("stage_status", [...STAGE_STATUSES] as [string, ...string[]]);
export const stageNameEnum = pgEnum("stage_name", [...STAGE_NAMES] as [string, ...string[]]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  description: text("description").notNull(),
  status: taskStatusEnum("status").notNull().default("queued"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
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

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
