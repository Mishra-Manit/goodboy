CREATE TYPE "public"."subagent_run_status" AS ENUM('running', 'complete', 'failed');--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_stage_id" uuid,
	"pr_session_run_id" uuid,
	"memory_run_id" uuid,
	"agent_name" text NOT NULL,
	"pi_session_id" text NOT NULL,
	"session_path" text NOT NULL,
	"model" text,
	"duration_ms" integer,
	"total_tokens" integer,
	"cost_usd" numeric,
	"tool_call_count" integer,
	CONSTRAINT "agent_sessions_one_owner_check" CHECK (((task_stage_id is not null)::int + (pr_session_run_id is not null)::int + (memory_run_id is not null)::int) = 1)
);
--> statement-breakpoint
CREATE TABLE "subagent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_agent_session_id" uuid NOT NULL,
	"agent_name" text NOT NULL,
	"run_index" integer,
	"prompt" text NOT NULL,
	"result_text" text,
	"status" "subagent_run_status" NOT NULL,
	"model" text,
	"duration_ms" integer,
	"total_tokens" integer,
	"cost_usd" numeric,
	"tool_call_count" integer
);
--> statement-breakpoint
CREATE TABLE "task_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"task_stage_id" uuid,
	"producer_session_id" uuid,
	"file_path" text NOT NULL,
	"content_text" text,
	"content_json" jsonb,
	"sha256" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_artifacts_one_content_check" CHECK ((content_text is not null and content_json is null) or (content_text is null and content_json is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_task_stage_id_task_stages_id_fk" FOREIGN KEY ("task_stage_id") REFERENCES "public"."task_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_pr_session_run_id_pr_session_runs_id_fk" FOREIGN KEY ("pr_session_run_id") REFERENCES "public"."pr_session_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_memory_run_id_memory_runs_id_fk" FOREIGN KEY ("memory_run_id") REFERENCES "public"."memory_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subagent_runs" ADD CONSTRAINT "subagent_runs_parent_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("parent_agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_task_stage_id_task_stages_id_fk" FOREIGN KEY ("task_stage_id") REFERENCES "public"."task_stages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_artifacts" ADD CONSTRAINT "task_artifacts_producer_session_id_agent_sessions_id_fk" FOREIGN KEY ("producer_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_pi_session_id_unique_idx" ON "agent_sessions" USING btree ("pi_session_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_task_stage_idx" ON "agent_sessions" USING btree ("task_stage_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_pr_session_run_idx" ON "agent_sessions" USING btree ("pr_session_run_id");--> statement-breakpoint
CREATE INDEX "agent_sessions_memory_run_idx" ON "agent_sessions" USING btree ("memory_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subagent_runs_parent_index_unique_idx" ON "subagent_runs" USING btree ("parent_agent_session_id","run_index");--> statement-breakpoint
CREATE UNIQUE INDEX "task_artifacts_task_file_unique_idx" ON "task_artifacts" USING btree ("task_id","file_path");--> statement-breakpoint
CREATE INDEX "task_artifacts_task_stage_idx" ON "task_artifacts" USING btree ("task_stage_id");--> statement-breakpoint
CREATE INDEX "task_artifacts_producer_session_idx" ON "task_artifacts" USING btree ("producer_session_id");