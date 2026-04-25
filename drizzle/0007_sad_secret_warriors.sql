ALTER TABLE "public"."task_stages" ALTER COLUMN "stage" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."stage_name";--> statement-breakpoint
CREATE TYPE "public"."stage_name" AS ENUM('memory', 'planner', 'implementer', 'reviewer', 'pr_creator', 'revision', 'answering', 'pr_impact', 'pr_analyst');--> statement-breakpoint
ALTER TABLE "public"."task_stages" ALTER COLUMN "stage" SET DATA TYPE "public"."stage_name" USING "stage"::"public"."stage_name";