import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOpenPrs: vi.fn(),
  isPrOpen: vi.fn(),
  listPrReviewTasksForRepo: vi.fn(),
  listPrSessionsForRepo: vi.fn(),
  listTasksForRepoAndPr: vi.fn(),
  listPrSessionsForRepoAndPr: vi.fn(),
  updatePrSession: vi.fn(),
  createTask: vi.fn(),
  runPrReview: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock("@src/core/git/github.js", () => ({
  listOpenPrs: (...args: unknown[]) => mocks.listOpenPrs(...args),
  isPrOpen: (...args: unknown[]) => mocks.isPrOpen(...args),
}));

vi.mock("@src/core/git/worktree.js", () => ({
  removeWorktree: (...args: unknown[]) => mocks.removeWorktree(...args),
}));

vi.mock("@src/db/repository.js", () => ({
  listPrReviewTasksForRepo: (...args: unknown[]) => mocks.listPrReviewTasksForRepo(...args),
  listPrSessionsForRepo: (...args: unknown[]) => mocks.listPrSessionsForRepo(...args),
  listTasksForRepoAndPr: (...args: unknown[]) => mocks.listTasksForRepoAndPr(...args),
  listPrSessionsForRepoAndPr: (...args: unknown[]) => mocks.listPrSessionsForRepoAndPr(...args),
  updatePrSession: (...args: unknown[]) => mocks.updatePrSession(...args),
  createTask: (...args: unknown[]) => mocks.createTask(...args),
}));

vi.mock("@src/pipelines/index.js", () => ({
  PIPELINES: {
    pr_review: (...args: unknown[]) => mocks.runPrReview(...args),
  },
}));

vi.mock("@src/shared/domain/repos.js", () => ({
  getRepo: (name: string) => name === "goodboy" ? { name, localPath: "/repo/goodboy", githubUrl: "https://github.com/acme/goodboy" } : null,
  getRepoNwo: (name: string) => name === "goodboy" ? "acme/goodboy" : null,
}));

vi.mock("@src/shared/runtime/events.js", () => ({
  emit: vi.fn(),
}));

import { registerPrReviewRoutes } from "@src/api/routes/pr-reviews.js";

const now = new Date("2026-05-03T12:00:00Z");

function app() {
  const hono = new Hono();
  registerPrReviewRoutes(hono);
  return hono;
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    repo: "goodboy",
    kind: "pr_review",
    description: "Review PR #12",
    status: "queued",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: 12,
    prIdentifier: "12",
    error: null,
    telegramChatId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null,
    ...overrides,
  };
}

function session(overrides: Record<string, unknown> = {}) {
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
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listOpenPrs.mockResolvedValue([{
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
  }]);
  mocks.isPrOpen.mockResolvedValue(true);
  mocks.listPrReviewTasksForRepo.mockResolvedValue([]);
  mocks.listPrSessionsForRepo.mockResolvedValue([]);
  mocks.listTasksForRepoAndPr.mockResolvedValue([]);
  mocks.listPrSessionsForRepoAndPr.mockResolvedValue([]);
  mocks.updatePrSession.mockResolvedValue(session({ status: "closed" }));
  mocks.createTask.mockResolvedValue(task());
  mocks.runPrReview.mockResolvedValue(undefined);
  mocks.removeWorktree.mockResolvedValue(undefined);
});

describe("PR review routes", () => {
  it("returns 400 when listing PRs without repo", async () => {
    const res = await app().fetch(new Request("http://goodboy.test/api/github/prs"));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "repo is required" });
  });

  it("returns merged open PR rows", async () => {
    mocks.listPrReviewTasksForRepo.mockResolvedValue([task({ id: "running", status: "running" })]);

    const res = await app().fetch(new Request("http://goodboy.test/api/github/prs?repo=goodboy"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      githubError: null,
      rows: [{ repo: "goodboy", number: 12, state: "review_running", reviewTaskId: "running" }],
    });
  });

  it("returns a 200 with githubError when GitHub discovery fails", async () => {
    mocks.listOpenPrs.mockRejectedValue(new Error("gh failed"));

    const res = await app().fetch(new Request("http://goodboy.test/api/github/prs?repo=goodboy"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ rows: [], githubError: "gh failed" });
  });

  it("creates a dashboard PR review task", async () => {
    const res = await app().fetch(new Request("http://goodboy.test/api/pr-reviews", {
      method: "POST",
      body: JSON.stringify({ repo: "goodboy", prNumber: 12 }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(201);
    expect(mocks.createTask).toHaveBeenCalledWith({
      repo: "goodboy",
      kind: "pr_review",
      description: "Review PR #12",
      telegramChatId: null,
      prIdentifier: "12",
    });
    expect(mocks.runPrReview).toHaveBeenCalledWith("task-1", expect.any(Function));
  });

  it("returns 409 when the PR is closed", async () => {
    mocks.isPrOpen.mockResolvedValue(false);

    const res = await app().fetch(new Request("http://goodboy.test/api/pr-reviews", {
      method: "POST",
      body: JSON.stringify({ repo: "goodboy", prNumber: 12 }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "PR is not open" });
  });

  it("returns 409 when a review task is already running", async () => {
    mocks.listTasksForRepoAndPr.mockResolvedValue([task({ id: "running", status: "running" })]);

    const res = await app().fetch(new Request("http://goodboy.test/api/pr-reviews", {
      method: "POST",
      body: JSON.stringify({ repo: "goodboy", prNumber: 12 }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "Review already running", taskId: "running" });
  });

  it("returns 409 when a review session exists and replacement was not requested", async () => {
    mocks.listPrSessionsForRepoAndPr.mockResolvedValue([session({ id: "review-session" })]);

    const res = await app().fetch(new Request("http://goodboy.test/api/pr-reviews", {
      method: "POST",
      body: JSON.stringify({ repo: "goodboy", prNumber: 12 }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "Review session already exists",
      sessionId: "review-session",
    });
  });

  it("closes the existing review session when replacement is requested", async () => {
    mocks.listPrSessionsForRepoAndPr.mockResolvedValue([session({ id: "review-session" })]);

    const res = await app().fetch(new Request("http://goodboy.test/api/pr-reviews", {
      method: "POST",
      body: JSON.stringify({ repo: "goodboy", prNumber: 12, replaceExisting: true }),
      headers: { "Content-Type": "application/json" },
    }));

    expect(res.status).toBe(201);
    expect(mocks.updatePrSession).toHaveBeenCalledWith("review-session", {
      status: "closed",
      worktreePath: null,
      branch: null,
    });
    expect(mocks.removeWorktree).toHaveBeenCalledWith("/repo/goodboy", "/tmp/wt");
    expect(mocks.createTask).toHaveBeenCalled();
  });
});
