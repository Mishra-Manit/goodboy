/**
 * PR inbox wire contract. Shared between backend (`api/pr-inbox.ts`) and
 * dashboard so the row shape never drifts.
 */

export const PR_INBOX_STATES = [
  "not_started",
  "owned",
  "review_running",
  "review_failed",
  "reviewed",
] as const;

export type PrInboxState = (typeof PR_INBOX_STATES)[number];

export type PrInboxOpenTarget =
  | { type: "task"; taskId: string }
  | { type: "pr_session"; sessionId: string }
  | { type: "external"; url: string };

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
  watchStatus: "watching" | "muted" | null;
  openTarget: PrInboxOpenTarget;
  canStartReview: boolean;
  canRetryReview: boolean;
  canRerunReview: boolean;
}

export interface PrInboxResponse {
  rows: PrInboxRow[];
  githubError: string | null;
}
