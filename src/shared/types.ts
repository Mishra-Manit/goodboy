/**
 * Shared runtime enums and wire types. Each const array is the single source
 * of truth for its TS union, the matching Postgres `pgEnum` in `db/schema.ts`,
 * and any runtime `.includes()` check. Do not declare these as hand-written
 * string unions elsewhere.
 */

// --- Task kinds ---

export const TASK_KINDS = ["coding_task", "codebase_question", "pr_review"] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

// --- Task statuses (generic lifecycle) ---

export const TASK_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

// --- Stage names (union across all kinds) ---

export const STAGE_NAMES = [
  // runs before every coding_task / codebase_question / pr_review
  "memory",
  // coding_task
  "planner",
  "implementer",
  "reviewer",
  "pr_creator",
  "revision",
  // codebase_question
  "answering",
  // pr_review
  "pr_reviewing",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_STATUSES = ["running", "complete", "failed", "skipped"] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

// --- Memory runs ---

export const MEMORY_RUN_KINDS = ["cold", "warm", "skip", "noop"] as const;

export type MemoryRunKind = (typeof MEMORY_RUN_KINDS)[number];

export const MEMORY_RUN_STATUSES = ["running", "complete", "failed"] as const;

export type MemoryRunStatus = (typeof MEMORY_RUN_STATUSES)[number];

export const MEMORY_RUN_SOURCES = ["task", "manual_test"] as const;

export type MemoryRunSource = (typeof MEMORY_RUN_SOURCES)[number];

// --- SSE events ---

import type { FileEntry } from "./session.js";

/**
 * Wire format for every server-sent event the dashboard consumes.
 *
 * `session_entry` carries a line freshly appended to a pi session file.
 * `scope` + `id` (+ optional `stage`) identify which file the line belongs
 * to so the dashboard can route it to the right view.
 */
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus; kind?: TaskKind }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "pr_update"; taskId: string; prUrl: string }
  | { type: "pr_session_update"; prSessionId: string; running: boolean }
  | {
      type: "session_entry";
      scope: "task" | "pr_session";
      id: string;
      stage?: StageName;
      entry: FileEntry;
    };
