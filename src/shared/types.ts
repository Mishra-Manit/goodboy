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

export const STAGE_STATUSES = ["running", "complete", "failed"] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

/** Structured marker emitted by pi instances at end of output */
export type PiOutputMarker = { status: "complete" };

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
  | "text"         // Agent prose / reasoning output
  | "tool_start"   // Tool invocation started
  | "tool_update"  // Streaming progress from a long-running tool (e.g. subagent)
  | "tool_end"     // Tool invocation finished
  | "tool_output"  // Truncated tool result
  | "stage_info"   // Stage lifecycle message
  | "rpc"          // RPC protocol message
  | "error"        // Error / warning
  | "stderr";      // Raw stderr

/**
 * Meta conventions for tool lifecycle entries. All tool_* entries include
 * `tool` (toolName) and `toolCallId` so the dashboard can correlate updates,
 * outputs, and the terminal tool_end to the originating start event.
 */

/** SSE event types */
export type SSEEvent =
  | { type: "task_update"; taskId: string; status: TaskStatus; kind?: TaskKind }
  | { type: "stage_update"; taskId: string; stage: StageName; status: StageStatus }
  | { type: "log"; taskId: string; stage: StageName; entry: LogEntry }
  | { type: "pr_update"; taskId: string; prUrl: string }
  | { type: "pr_session_update"; prSessionId: string; running: boolean }
  | { type: "pr_session_log"; prSessionId: string; entry: LogEntry };
