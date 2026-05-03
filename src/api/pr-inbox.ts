/** Pure merge logic for GitHub-open PRs plus Goodboy task/session state. */

import type { GitHubOpenPr } from "../core/git/github.js";
import type { PrSession, Task } from "../db/repository.js";
import { isTerminalStatus } from "../shared/domain/types.js";

// Ordered by display meaning, not priority. Priority lives in composePrInboxRows.
export const PR_INBOX_STATES = [
  "not_started",
  "owned",
  "review_running",
  "review_failed",
  "reviewed",
] as const;

export type PrInboxState = (typeof PR_INBOX_STATES)[number];

/** One dashboard row: live GitHub PR fields plus Goodboy's best-known review state. */
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
  watchStatus: "watching" | "muted" | null;
  canStartReview: boolean;
  canRetryReview: boolean;
  canRerunReview: boolean;
}

/** Merge live GitHub rows with persisted tasks/sessions without touching IO. */
export function composePrInboxRows(input: {
  repo: string;
  openPrs: readonly GitHubOpenPr[];
  tasks: readonly Task[];
  sessions: readonly PrSession[];
}): PrInboxRow[] {
  return input.openPrs.map((pr) => {
    const matchingTasks = input.tasks.filter((task) => matchesTaskPr(task, pr.number));
    const matchingSessions = input.sessions.filter((session) => session.prNumber === pr.number);

    const reviewRunning = matchingTasks.find((task) => (
      task.kind === "pr_review" && !isTerminalStatus(task.status)
    ));
    const reviewFailed = matchingTasks.find((task) => task.kind === "pr_review" && task.status === "failed");
    const reviewSession = matchingSessions.find((session) => (
      session.mode === "review" && session.status === "active"
    ));
    const ownSession = matchingSessions.find((session) => (
      session.mode === "own" && session.status === "active"
    ));

    // Prefer the action the user needs now: watch running work, retry failures, then open completed sessions.
    const state: PrInboxState = reviewRunning
      ? "review_running"
      : reviewFailed
        ? "review_failed"
        : reviewSession
          ? "reviewed"
          : ownSession
            ? "owned"
            : "not_started";
    const watchSession = reviewSession ?? ownSession;

    return {
      repo: input.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      updatedAt: pr.updatedAt,
      isDraft: pr.isDraft,
      reviewDecision: pr.reviewDecision,
      labels: pr.labels,
      state,
      ownSessionId: ownSession?.id ?? null,
      reviewSessionId: reviewSession?.id ?? null,
      reviewTaskId: reviewRunning?.id ?? reviewFailed?.id ?? null,
      watchSessionId: watchSession?.id ?? null,
      watchStatus: watchSession?.watchStatus ?? null,
      canStartReview: !reviewRunning && !reviewFailed && !reviewSession,
      canRetryReview: !!reviewFailed && !reviewRunning,
      canRerunReview: !!reviewSession && !reviewRunning,
    };
  });
}

function matchesTaskPr(task: Task, prNumber: number): boolean {
  return task.prNumber === prNumber || task.prIdentifier === String(prNumber);
}
