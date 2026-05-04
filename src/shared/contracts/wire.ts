/**
 * Canonical wire types for every JSON API response. Dates are `string` (ISO)
 * because JSON.stringify turns them into strings at the trust boundary.
 *
 * Both backend routes and the dashboard import from here so the shapes never
 * drift. Backend Drizzle types are cast to these wire types at return time;
 * the runtime already produces the same JSON.
 */

import type {
  TaskKind,
  TaskStatus,
  StageName,
  StageStatus,
  PrSessionMode,
  PrSessionWatchStatus,
  MemoryRunKind,
  MemoryRunStatus,
  MemoryRunSource,
  PrComment,
} from "../domain/types.js";

// --- Tasks ---

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
  instance: string;
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

// --- PR sessions ---

export interface PrSession {
  id: string;
  repo: string;
  prNumber: number | null;
  branch: string | null;
  worktreePath: string | null;
  status: "active" | "closed";
  watchStatus: PrSessionWatchStatus;
  mode: PrSessionMode;
  sourceTaskId: string | null;
  telegramChatId: string | null;
  lastPolledAt: string | null;
  instance: string;
  createdAt: string;
  updatedAt: string;
}

/** PrSession enriched with the runtime-computed `prUrl`. */
export interface PrSessionWithUrl extends PrSession {
  prUrl: string | null;
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

export interface PrSessionWithRuns extends PrSessionWithUrl {
  runs: PrSessionRun[];
}

// --- Memory ---

export interface MemoryZone {
  name: string;
  path: string;
  summary: string;
}

export interface MemoryStatus {
  repo: string;
  status: "fresh" | "stale" | "missing";
  lastIndexedSha: string | null;
  lastIndexedAt: string | null;
  fileCount: number;
  totalBytes: number;
  zones: MemoryZone[];
}

export interface MemoryRun {
  id: string;
  instance: string;
  repo: string;
  source: MemoryRunSource;
  kind: MemoryRunKind;
  status: MemoryRunStatus;
  active: "TRUE" | "FALSE";
  originTaskId: string | null;
  externalLabel: string | null;
  sha: string | null;
  zoneCount: number | null;
  error: string | null;
  sessionPath: string | null;
  startedAt: string;
  completedAt: string | null;
}

// --- Repos ---

export interface RepoSummary {
  name: string;
  githubUrl?: string;
}

// --- Code reviewer feedback ---

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

// --- Stage transcript ---

export interface StageSession {
  stage: StageName;
  variant: number | null;
  entries: import("./session.js").FileEntry[];
}

// --- Generic API responses ---

export interface CreateTaskResponse {
  ok: true;
  task: Task;
}
