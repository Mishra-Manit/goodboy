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
  PrReviewPageDto,
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
  PrInboxRow,
  PrInboxState,
  PrInboxResponse,
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

// --- Narrow dashboard renames (RepoSummary -> Repo for legacy call sites) ---

/** @deprecated Use `RepoSummary` from `@dashboard/lib/api` instead. */
export type Repo = import("@dashboard/shared").RepoSummary;
