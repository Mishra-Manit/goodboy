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

/** Structured log entry emitted by pi-rpc and stored on disk */
export interface LogEntry {
  /** Monotonic index within the stage */
  seq: number;
  /** ISO timestamp */
  ts: string;
  /** Semantic category */
  kind: LogEntryKind;
  /** Human-readable text */
  text: string;
  /** Optional metadata (tool name, args, duration, etc.) */
  meta?: Record<string, unknown>;
}

export type LogEntryKind =
  | "text"        // Agent prose / reasoning output
  | "tool_start"  // Tool invocation started
  | "tool_end"    // Tool invocation finished
  | "tool_output" // Truncated tool result
  | "stage_info"  // Stage lifecycle message
  | "rpc"         // RPC protocol message
  | "error"       // Error / warning
  | "stderr";     // Raw stderr

/** SSE event types */
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "log"; taskId: string; stage: StageName; entry: LogEntry }
  | { type: "pr_update"; taskId: string; prUrl: string };
