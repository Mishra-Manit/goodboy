/** Narrow re-export of backend wire types. The dashboard never duplicates enums. */

export {
  TASK_KINDS,
  TASK_STATUSES,
  STAGE_STATUSES,
  STAGE_NAMES,
  MEMORY_RUN_KINDS,
  MEMORY_RUN_STATUSES,
  MEMORY_RUN_SOURCES,
  isTerminalStatus,
} from "@shared/domain/types.js";

export type {
  TaskKind,
  TaskStatus,
  StageStatus,
  StageName,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
  SSEEvent,
  PrSessionWatchStatus,
  PrSessionMode,
  PrComment,
  PrReviewState,
} from "@shared/domain/types.js";

export {
  prReviewPageDtoSchema,
  reviewChatResponseSchema,
  reviewChatPostResponseSchema,
} from "@shared/contracts/pr-review.js";

export type {
  PrReviewAnnotation,
  PrReviewAnnotationKind,
  PrReviewArtifact,
  PrReviewChapter,
  PrReviewPageDto,
  ReviewChatMessage,
  ReviewChatPart,
  ReviewChatRequest,
  ReviewChatResponse,
  ReviewChatPostResponse,
} from "@shared/contracts/pr-review.js";

export { TASK_KIND_CONFIG } from "@shared/domain/task-kinds.js";
export type { TaskKindConfig } from "@shared/domain/task-kinds.js";

export { shortId } from "@shared/lib/strings.js";

export { TEST_INSTANCE_PREFIX, isTestInstance } from "@shared/domain/test-instance.js";

export type { PrInboxOpenTarget, PrInboxRow, PrInboxState, PrInboxResponse } from "@shared/contracts/pr-inbox.js";

export type {
  Task,
  TaskStage,
  TaskWithStages,
  PrSession,
  PrSessionWithUrl,
  PrSessionRun,
  PrSessionWithRuns,
  MemoryZone,
  MemoryStatus,
  MemoryRun,
  RepoSummary,
  CodeReviewerFeedbackRule,
  CodeReviewerFeedbackStatus,
  CodeReviewerFeedbackScope,
  CodeReviewerFeedbackSource,
  StageSession,
  CreateTaskResponse,
} from "@shared/contracts/wire.js";

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
} from "@shared/contracts/session.js";
