CREATE TABLE "pr_session_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pr_session_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"comments" jsonb,
	"status" text NOT NULL,
	"error" text,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pr_session_runs" ADD CONSTRAINT "pr_session_runs_pr_session_id_pr_sessions_id_fk" FOREIGN KEY ("pr_session_id") REFERENCES "public"."pr_sessions"("id") ON DELETE no action ON UPDATE no action;