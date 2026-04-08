export const TASK_STATUSES = [
  "queued",
  "planning",
  "implementing",
  "reviewing",
  "creating_pr",
  "revision",
  "complete",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STAGE_NAMES = [
  "planner",
  "implementer",
  "reviewer",
  "pr_creator",
  "revision",
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export const STAGE_STATUSES = ["running", "complete", "failed"] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Structured marker emitted by pi instances at end of output */
export type PiOutputMarker =
  | { status: "needs_input"; questions: string[] }
  | { status: "complete" }
  | { status: "ready"; summary: string };

/** Mapping from stage name to the task status it corresponds to */
export const STAGE_TO_STATUS: Record<StageName, TaskStatus> = {
  planner: "planning",
  implementer: "implementing",
  reviewer: "reviewing",
  pr_creator: "creating_pr",
  revision: "revision",
};

/** SSE event types */
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "log"; taskId: string; stage: StageName; line: string }
  | { type: "pr_update"; taskId: string; prUrl: string };
