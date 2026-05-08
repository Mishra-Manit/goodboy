/** Dashboard-side wire types. Enum sources of truth live in `@dashboard/shared`. */

import type {
  FileEntry,
  TaskKind,
  TaskStatus,
  StageStatus,
  StageName,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
  PrSessionWatchStatus,
  PrSessionMode,
  PrComment,
  PrReviewPageDto,
  TaskPrReviewPageDto,
} from "@dashboard/shared";

export type {
  PrSessionMode,
  PrComment,
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  AgentMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  BashExecutionMessage,
  TextContent,
  ThinkingContent,
  ImageContent,
  ToolCall,
  SSEEvent,
  TaskKind,
  TaskStatus,
  StageStatus,
  StageName,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
  PrSessionWatchStatus,
  PrReviewAnnotation,
  PrReviewAnnotationKind,
  PrReviewArtifact,
  PrReviewChapter,
  PrReviewFile,
  PrReviewPageDto,
  TaskPrReviewPageDto,
} from "@dashboard/shared";

export { TASK_KIND_CONFIG } from "@dashboard/shared";

// --- Wire types (shared contract, single source of truth) ---

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
  PrInboxOpenTarget,
  PrInboxRow,
  PrInboxState,
  PrInboxResponse,
  PrSessionReconcileAction,
  PrSessionReconcileItem,
  PrSessionReconcileSummary,
} from "@dashboard/shared";

// --- API-specific response wrappers ---

export interface CreatePrReviewResponse {
  ok: true;
  task: Task;
}

export interface RetryTaskResponse {
  ok: true;
  task: Task;
}
