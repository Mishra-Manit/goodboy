import { describe, expect, it } from "vitest";
import { composePrInboxRows, type PrInboxRow } from "@src/api/pr-inbox.js";
import type { GitHubOpenPr } from "@src/core/git/github.js";
import type { PrSession, Task } from "@src/db/repository.js";

const now = new Date("2026-05-03T12:00:00Z");
const pr: GitHubOpenPr = {
  number: 12,
  title: "Add PR inbox",
  url: "https://github.com/acme/goodboy/pull/12",
  author: "manit",
  headRef: "feat/pr-inbox",
  baseRef: "main",
  updatedAt: now.toISOString(),
  isDraft: false,
  reviewDecision: null,
  labels: ["backend"],
};

function compose(input: {
  tasks?: readonly Task[];
  sessions?: readonly PrSession[];
}): PrInboxRow {
  return composePrInboxRows({
    repo: "goodboy",
    openPrs: [pr],
    tasks: input.tasks ?? [],
    sessions: input.sessions ?? [],
  })[0];
}

function task(overrides: Partial<Task>): Task {
  return {
    id: "task-1",
    repo: "goodboy",
    kind: "pr_review",
    description: "Review PR #12",
    status: "complete",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: 12,
    prIdentifier: null,
    error: null,
    instance: "test",
    telegramChatId: null,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ...overrides,
  };
}

function session(overrides: Partial<PrSession>): PrSession {
  return {
    id: "session-1",
    repo: "goodboy",
    prNumber: 12,
    branch: "review/pr-12",
    worktreePath: "/tmp/wt",
    status: "active",
    watchStatus: "watching",
    mode: "review",
    sourceTaskId: "task-1",
    telegramChatId: null,
    lastPolledAt: null,
    instance: "test",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("composePrInboxRows", () => {
  it("prefers an active review task over failed tasks and sessions", () => {
    const row = compose({
      tasks: [task({ id: "failed", status: "failed" }), task({ id: "running", status: "running" })],
      sessions: [session({ id: "review-session" })],
    });

    expect(row.state).toBe("review_running");
    expect(row.reviewTaskId).toBe("running");
    expect(row.canStartReview).toBe(false);
  });

  it("prefers a failed review task over an existing review session", () => {
    const row = compose({
      tasks: [task({ id: "failed", status: "failed" })],
      sessions: [session({ id: "review-session" })],
    });

    expect(row.state).toBe("review_failed");
    expect(row.reviewTaskId).toBe("failed");
    expect(row.canRetryReview).toBe(true);
  });

  it("prefers a review session over an own session", () => {
    const row = compose({
      sessions: [
        session({ id: "own-session", mode: "own" }),
        session({ id: "review-session", mode: "review" }),
      ],
    });

    expect(row.state).toBe("reviewed");
    expect(row.reviewSessionId).toBe("review-session");
    expect(row.ownSessionId).toBe("own-session");
    expect(row.canRerunReview).toBe(true);
  });

  it("allows an own-only PR to start review", () => {
    const row = compose({ sessions: [session({ id: "own-session", mode: "own" })] });

    expect(row.state).toBe("owned");
    expect(row.canStartReview).toBe(true);
  });

  it("marks untouched PRs as not started", () => {
    const row = compose({});

    expect(row.state).toBe("not_started");
    expect(row.canStartReview).toBe(true);
    expect(row.reviewTaskId).toBeNull();
  });
});
