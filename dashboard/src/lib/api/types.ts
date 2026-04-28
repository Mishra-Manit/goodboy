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
} from "@dashboard/shared";

export type {
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
  PrSessionMode,
  PrComment,
  PrReviewState,
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
  stage: string;
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

// --- Repos + session transcripts ---

export interface Repo {
  name: string;
  localPath: string;
  githubUrl?: string;
}

/** One stage's share of a task's pi session transcript. */
export interface StageSession {
  stage: StageName;
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
