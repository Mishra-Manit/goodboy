CREATE TYPE "public"."pr_session_status" AS ENUM('active', 'closed');--> statement-breakpoint
CREATE TABLE "pr_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repo" text NOT NULL,
	"pr_number" integer,
	"branch" text,
	"worktree_path" text,
	"status" "pr_session_status" DEFAULT 'active' NOT NULL,
	"origin_task_id" uuid,
	"telegram_chat_id" text,
	"last_polled_at" timestamp,
	"instance" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_sessions" ADD CONSTRAINT "pr_sessions_origin_task_id_tasks_id_fk" FOREIGN KEY ("origin_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;