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

// --- Task resources ---

export interface Task {
  id: string;
  repo: string;
  kind: TaskKind;
  description: string;
  status: TaskStatus;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prIdentifier: string | null;
  error: string | null;
  telegramChatId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface TaskStage {
  id: string;
  taskId: string;
  stage: StageName;
  variant: number | null;
  status: StageStatus;
  startedAt: string;
  completedAt: string | null;
  piSessionId: string | null;
  error: string | null;
}

export interface TaskWithStages extends Task {
  stages: TaskStage[];
}

// --- PR + session resources ---

export type PrSessionStatus = "active" | "closed";

export interface PrSession {
  id: string;
  repo: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  worktreePath: string | null;
  status: PrSessionStatus;
  watchStatus: PrSessionWatchStatus;
  mode: PrSessionMode;
  sourceTaskId: string | null;
  telegramChatId: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrSessionRun {
  id: string;
  prSessionId: string;
  trigger: string;
  comments: PrComment[] | null;
  status: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PrSessionWithRuns extends PrSession {
  runs: PrSessionRun[];
}

/** Dashboard state derived from open GitHub PRs plus Goodboy tasks/sessions. */
export type PrInboxState =
  | "not_started"
  | "owned"
  | "review_running"
  | "review_failed"
  | "reviewed";

/** Open PR row with precomputed action flags so the UI stays dumb. */
export interface PrInboxRow {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  isDraft: boolean;
  reviewDecision: string | null;
  labels: readonly string[];
  state: PrInboxState;
  ownSessionId: string | null;
  reviewSessionId: string | null;
  reviewTaskId: string | null;
  watchSessionId: string | null;
  watchStatus: PrSessionWatchStatus | null;
  canStartReview: boolean;
  canRetryReview: boolean;
  canRerunReview: boolean;
}

export interface PrInboxResponse {
  rows: PrInboxRow[];
  githubError: string | null;
}

export interface CreatePrReviewResponse {
  ok: true;
  task: Task;
}

// --- Repos + session transcripts ---

export interface Repo {
  name: string;
  githubUrl?: string;
}

/** One stage's share of a task's pi session transcript. */
export interface StageSession {
  stage: StageName;
  variant: number | null;
  entries: FileEntry[];
}

// --- Memory ---

export interface MemoryZone {
  name: string;
  path: string;
  summary: string;
}

export type MemoryStatusKind = "fresh" | "stale" | "missing";

export interface MemoryStatus {
  repo: string;
  status: MemoryStatusKind;
  lastIndexedSha: string | null;
  lastIndexedAt: string | null;
  fileCount: number;
  totalBytes: number;
  zones: MemoryZone[];
}

export type MemoryRunActive = "TRUE" | "FALSE";

// --- Code Reviewer Feedback ---

export type CodeReviewerFeedbackStatus = "active" | "inactive";

export type CodeReviewerFeedbackScope =
  | { type: "global" }
  | { type: "path"; paths: string[] }
  | { type: "review_behavior" };

export interface CodeReviewerFeedbackSource {
  type: "github_comment" | "dashboard_chat";
  prNumber: number;
  originalText: string;
}

export interface CodeReviewerFeedbackRule {
  id: string;
  status: CodeReviewerFeedbackStatus;
  title: string;
  rule: string;
  scope: CodeReviewerFeedbackScope;
  source: CodeReviewerFeedbackSource;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryRun {
  id: string;
  instance: string;
  repo: string;
  source: MemoryRunSource;
  kind: MemoryRunKind;
  status: MemoryRunStatus;
  active: MemoryRunActive;
  originTaskId: string | null;
  externalLabel: string | null;
  sha: string | null;
  zoneCount: number | null;
  error: string | null;
  sessionPath: string | null;
  startedAt: string;
  completedAt: string | null;
}
