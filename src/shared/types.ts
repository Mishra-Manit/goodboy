/**
 * Shared runtime enums and wire types. Each const array is the single source
 * of truth for its TS union, the matching Postgres `pgEnum` in `db/schema.ts`,
 * and any runtime `.includes()` check. Do not declare these as hand-written
 * string unions elsewhere.
 */

import { z } from "zod";
import type { FileEntry } from "./session.js";

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

export const TERMINAL_STATUSES = ["complete", "failed", "cancelled"] as const;

export type TerminalTaskStatus = (typeof TERMINAL_STATUSES)[number];

/** True when the task status is terminal and no more work should run. */
export function isTerminalStatus(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

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
  "pr_impact",
  "pr_analyst",
  "pr_display",
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

// --- PR sessions ---

export const PR_SESSION_WATCH_STATUSES = ["watching", "muted"] as const;

export type PrSessionWatchStatus = (typeof PR_SESSION_WATCH_STATUSES)[number];

export const PR_SESSION_MODES = ["own", "review"] as const;

export type PrSessionMode = (typeof PR_SESSION_MODES)[number];

// --- PR comments ---

export const PR_REVIEW_STATES = ["approved", "changes_requested", "commented"] as const;

export type PrReviewState = (typeof PR_REVIEW_STATES)[number];

interface PrCommentBase {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

/**
 * Discriminated PR comment from the watcher. `conversation` = top-level
 * issue comment; `inline` = code-level review comment with file/line;
 * `review_summary` = the body of a submitted review along with its state.
 */
export type PrComment =
  | (PrCommentBase & { kind: "conversation" })
  | (PrCommentBase & { kind: "inline"; path: string; line: number | null })
  | (PrCommentBase & { kind: "review_summary"; state: PrReviewState });

// --- SSE events ---

/**
 * Wire format for every server-sent event the dashboard consumes.
 *
 * `session_entry` carries a line freshly appended to a pi session file.
 * `scope` + `id` identify which file the line belongs to; task-scoped memory
 * stage entries also carry `memoryRunId` so `/memory/:id` can subscribe
 * directly without first resolving the underlying task/manual-test label.
 */
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus; kind?: TaskKind }
  | { type: "stage_update"; taskId: string; stage: StageName; variant?: number; status: StageStatus }
  | { type: "pr_update"; taskId: string; prUrl: string }
  | { type: "pr_session_update"; prSessionId: string; running: boolean }
  | {
      type: "memory_run_update";
      runId: string;
      repo: string;
      kind: MemoryRunKind;
      status: MemoryRunStatus;
      /** taskId used for the underlying stage session (originTaskId or externalLabel). */
      sessionTaskId: string;
    }
  | {
      type: "session_entry";
      scope: "task";
      id: string;
      stage?: StageName;
      /** Present when the stage has multiple parallel runs, e.g. pr_impact. */
      variant?: number;
      /** Present when this task-scoped stream belongs to a memory run row. */
      memoryRunId?: string;
      entry: FileEntry;
    }
  | {
      type: "session_entry";
      scope: "pr_session";
      id: string;
      entry: FileEntry;
    };

// --- PR review contract ---

export const PR_REVIEW_SEVERITIES = ["blocker", "major", "minor", "nit"] as const;
export const PR_REVIEW_CATEGORIES = ["correctness", "style", "tests", "security"] as const;

/**
 * Single reviewer finding. `suggested_fix` is prose, not a patch -- the
 * analyst decides whether to auto-apply it based on severity + category.
 */
export const prReviewIssueSchema = z.object({
  file: z.string().min(1),
  line_start: z.number().int().nonnegative(),
  line_end: z.number().int().nonnegative(),
  severity: z.enum(PR_REVIEW_SEVERITIES),
  category: z.enum(PR_REVIEW_CATEGORIES),
  title: z.string().min(1),
  rationale: z.string().min(1),
  suggested_fix: z.string().min(1),
});
export type PrReviewIssue = z.infer<typeof prReviewIssueSchema>;

/** One subagent's report, written to artifacts/<taskId>/reports/<subagent_id>.json. */
export const prReviewReportSchema = z.object({
  subagent_id: z.string().min(1),
  files_reviewed: z.array(z.string()),
  dimensions: z.array(z.enum(PR_REVIEW_CATEGORIES)).min(1),
  issues: z.array(prReviewIssueSchema),
  notes: z.string().default(""),
});
export type PrReviewReport = z.infer<typeof prReviewReportSchema>;

/** Analyst's fan-out plan, written to artifacts/<taskId>/review-plan.json. */
export const prReviewPlanSchema = z.object({
  groups: z.array(z.object({
    id: z.string().min(1),
    files: z.array(z.string()).min(1),
    dimensions: z.array(z.enum(PR_REVIEW_CATEGORIES)).min(1),
    focus: z.string().default(""),
  })).min(1),
  skipped: z.array(z.string()),
  focus_notes: z.string(),
});
export type PrReviewPlan = z.infer<typeof prReviewPlanSchema>;
