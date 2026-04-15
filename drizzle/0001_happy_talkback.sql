-- Add new stage_name enum (task_stages.stage was plain text, now typed)
CREATE TYPE "public"."stage_name" AS ENUM('planner', 'implementer', 'reviewer', 'pr_creator', 'revision', 'answering', 'pr_reviewing');--> statement-breakpoint

-- Add task_kind enum
CREATE TYPE "public"."task_kind" AS ENUM('coding_task', 'codebase_question', 'pr_review');--> statement-breakpoint

-- Drop stale repos table (removed from schema, was replaced by env config)
-- Note: may already be gone via db:push, so both are IF EXISTS
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'repos') THEN
    ALTER TABLE "repos" DISABLE ROW LEVEL SECURITY;
    DROP TABLE "repos" CASCADE;
  END IF;
END $$;--> statement-breakpoint

-- Type the stage column with the new enum
ALTER TABLE "task_stages" ALTER COLUMN "stage" SET DATA TYPE "public"."stage_name" USING "stage"::"public"."stage_name";--> statement-breakpoint

-- Add kind column (defaults to coding_task for all existing rows)
ALTER TABLE "tasks" ADD COLUMN "kind" "public"."task_kind" DEFAULT 'coding_task' NOT NULL;--> statement-breakpoint

-- Add pr_identifier column (used by pr_review tasks)
ALTER TABLE "tasks" ADD COLUMN "pr_identifier" text;--> statement-breakpoint

-- Migrate existing task statuses to generic lifecycle values
UPDATE "tasks" SET "status" = 'running' WHERE "status" IN ('planning', 'implementing', 'reviewing', 'creating_pr', 'revision');--> statement-breakpoint

-- Recreate task_status enum with generic values
ALTER TABLE "public"."tasks" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."task_status";--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'complete', 'failed', 'cancelled');--> statement-breakpoint
ALTER TABLE "public"."tasks" ALTER COLUMN "status" SET DATA TYPE "public"."task_status" USING "status"::"public"."task_status";--> statement-breakpoint
ALTER TABLE "public"."tasks" ALTER COLUMN "status" SET DEFAULT 'queued';
