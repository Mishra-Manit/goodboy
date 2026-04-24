/** Narrow re-export of backend wire types. The dashboard never duplicates enums. */

export {
  TASK_KINDS,
  TASK_STATUSES,
  STAGE_STATUSES,
  STAGE_NAMES,
  MEMORY_RUN_KINDS,
  MEMORY_RUN_STATUSES,
  MEMORY_RUN_SOURCES,
} from "@shared/types.js";

export type {
  TaskKind,
  TaskStatus,
  StageStatus,
  StageName,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
  SSEEvent,
} from "@shared/types.js";

export { TASK_KIND_CONFIG } from "@shared/task-kinds.js";
export type { TaskKindConfig } from "@shared/task-kinds.js";

export { TEST_INSTANCE_PREFIX, isTestInstance } from "@shared/test-instance.js";

export type {
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionEntryBase,
  SessionMessageEntry,
  AgentMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  BashExecutionMessage,
  CustomMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  Usage,
  StopReason,
} from "@shared/session.js";
