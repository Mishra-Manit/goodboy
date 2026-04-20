/** Dashboard-side wire types. Enum sources of truth live in `@dashboard/shared`. */

import type { FileEntry, TaskKind, TaskStatus, StageStatus, StageName } from "@dashboard/shared";

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
} from "@dashboard/shared";

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

export interface PR {
  taskId: string;
  repo: string;
  prUrl: string | null;
  prNumber: number | null;
  status: TaskStatus;
}

export type PrSessionStatus = "active" | "closed";

export interface PrSession {
  id: string;
  repo: string;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  worktreePath: string | null;
  status: PrSessionStatus;
  originTaskId: string | null;
  telegramChatId: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrSessionRun {
  id: string;
  prSessionId: string;
  trigger: string;
  comments: Array<{ author: string; body: string; path?: string; line?: number }> | null;
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

// --- Per-kind UI config ---

/** Per-kind pipeline + artifact catalogue. Keyed off `TaskKind`, so a new kind forces a compile error. */
export const TASK_KIND_CONFIG: Record<
  TaskKind,
  { label: string; stages: string[]; artifacts: { key: string; label: string }[] }
> = {
  coding_task: {
    label: "coding task",
    stages: ["planner", "implementer", "reviewer"],
    artifacts: [
      { key: "plan.md", label: "plan" },
      { key: "implementation-summary.md", label: "summary" },
      { key: "review.md", label: "review" },
    ],
  },
  codebase_question: {
    label: "question",
    stages: ["answering"],
    artifacts: [{ key: "answer.md", label: "answer" }],
  },
  pr_review: {
    label: "PR review",
    stages: ["pr_reviewing"],
    artifacts: [{ key: "pr-review.md", label: "review" }],
  },
};
