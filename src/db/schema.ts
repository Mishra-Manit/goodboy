import { pgTable, text, timestamp, integer, uuid, pgEnum } from "drizzle-orm/pg-core";

export const taskStatusEnum = pgEnum("task_status", [
  "queued",
  "planning",
  "implementing",
  "reviewing",
  "creating_pr",
  "revision",
  "complete",
  "failed",
  "cancelled",
]);

export const stageStatusEnum = pgEnum("stage_status", [
  "running",
  "complete",
  "failed",
]);

export const tasks = pgTable("tasks", {
  id: uuid("id").primaryKey().defaultRandom(),
  repo: text("repo").notNull(),
  description: text("description").notNull(),
  status: taskStatusEnum("status").notNull().default("queued"),
  currentStage: text("current_stage"),
  branch: text("branch"),
  worktreePath: text("worktree_path"),
  prUrl: text("pr_url"),
  prNumber: integer("pr_number"),
  error: text("error"),
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
  stage: text("stage").notNull(),
  status: stageStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  piSessionId: text("pi_session_id"),
  error: text("error"),
});

export const repos = pgTable("repos", {
  name: text("name").primaryKey(),
  localPath: text("local_path").notNull(),
  githubUrl: text("github_url"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
