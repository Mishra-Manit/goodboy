CREATE TYPE "public"."pr_session_mode" AS ENUM('own', 'review');--> statement-breakpoint
ALTER TABLE "pr_sessions" ADD COLUMN "mode" "pr_session_mode";--> statement-breakpoint
ALTER TABLE "pr_sessions" ADD COLUMN "source_task_id" uuid;--> statement-breakpoint
ALTER TABLE "pr_sessions" ADD CONSTRAINT "pr_sessions_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
UPDATE "pr_sessions"
SET "mode" = CASE WHEN "origin_task_id" IS NOT NULL THEN 'own'::pr_session_mode ELSE 'review'::pr_session_mode END,
    "source_task_id" = "origin_task_id";--> statement-breakpoint
ALTER TABLE "pr_sessions" ALTER COLUMN "mode" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pr_sessions" DROP CONSTRAINT "pr_sessions_origin_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "pr_sessions" DROP COLUMN "origin_task_id";
