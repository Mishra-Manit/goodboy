CREATE TYPE "public"."stage_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'planning', 'implementing', 'reviewing', 'creating_pr', 'revision', 'complete', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "repos" (
	"name" text PRIMARY KEY NOT NULL,
	"local_path" text NOT NULL,
	"github_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" "stage_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"pi_session_id" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"description" text NOT NULL,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"branch" text,
	"worktree_path" text,
	"pr_url" text,
	"pr_number" integer,
	"error" text,
	"telegram_chat_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "task_stages" ADD CONSTRAINT "task_stages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;