import { pgTable, text, timestamp, integer, uuid, pgEnum } from "drizzle-orm/pg-core";

// Enum values inlined here so drizzle-kit can resolve schema.ts without
// following ESM imports. The canonical TypeScript types live in shared/types.ts.

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

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
