CREATE TYPE "public"."memory_run_kind" AS ENUM('cold', 'warm', 'skip', 'noop');--> statement-breakpoint
CREATE TYPE "public"."memory_run_source" AS ENUM('task', 'manual_test');--> statement-breakpoint
CREATE TYPE "public"."memory_run_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "memory_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance" text NOT NULL,
	"repo" text NOT NULL,
	"source" "memory_run_source" NOT NULL,
	"kind" "memory_run_kind" NOT NULL,
	"status" "memory_run_status" DEFAULT 'running' NOT NULL,
	"origin_task_id" uuid,
	"external_label" text,
	"sha" text,
	"zone_count" integer,
	"error" text,
	"session_path" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "memory_runs" ADD CONSTRAINT "memory_runs_origin_task_id_tasks_id_fk" FOREIGN KEY ("origin_task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_runs_repo_started_at_idx" ON "memory_runs" USING btree ("repo","started_at");--> statement-breakpoint
CREATE INDEX "memory_runs_instance_started_at_idx" ON "memory_runs" USING btree ("instance","started_at");--> statement-breakpoint
CREATE INDEX "memory_runs_repo_kind_started_at_idx" ON "memory_runs" USING btree ("repo","kind","started_at");