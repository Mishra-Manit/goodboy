CREATE TYPE "public"."memory_run_active" AS ENUM('TRUE', 'FALSE');--> statement-breakpoint
ALTER TABLE "memory_runs" ADD COLUMN "active" "memory_run_active" DEFAULT 'TRUE' NOT NULL;--> statement-breakpoint
CREATE INDEX "memory_runs_repo_active_started_at_idx" ON "memory_runs" USING btree ("repo","active","started_at");