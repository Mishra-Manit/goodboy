/** Narrow re-export of backend wire types. The dashboard never duplicates enums. */

export {
  TASK_KINDS,
  TASK_STATUSES,
  STAGE_STATUSES,
  STAGE_NAMES,
} from "@shared/types.js";

export type {
  TaskKind,
  TaskStatus,
  StageStatus,
  StageName,
  LogEntry,
  LogEntryKind,
  SSEEvent,
} from "@shared/types.js";
