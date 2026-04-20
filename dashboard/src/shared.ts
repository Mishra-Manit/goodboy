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
  SSEEvent,
} from "@shared/types.js";

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
