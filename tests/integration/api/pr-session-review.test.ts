import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@src/shared/runtime/config.js";
import { taskArtifactsDir } from "@src/shared/artifact-paths/index.js";
import { prReviewOutputs } from "@src/pipelines/pr-review/output-contracts.js";
import type { PrReviewArtifact } from "@src/shared/contracts/pr-review.js";

const mocks = vi.hoisted(() => ({
  getPrSession: vi.fn(),
  getPrSessionBySourceTask: vi.fn(),
  getTask: vi.fn(),
  listPrSessionsForRepoAndPr: vi.fn(),
  listTasksForRepoAndPr: vi.fn(),
}));

vi.mock("@src/shared/domain/repos.js", () => ({
  getRepo: () => null,
  listRepos: () => [],
  buildPrUrl: (_repo: string, prNumber: number | null) => (
    prNumber ? `https://github.com/acme/widgets/pull/${prNumber}` : null
  ),
}));

vi.mock("@src/core/memory/index.js", () => ({
  memoryStatus: async () => ({ state: null, fileCount: 0, totalBytes: 0 }),
  currentHeadSha: async () => "head-sha",
  tryAcquireLock: async () => true,
  releaseLock: async () => undefined,
}));

vi.mock("@src/core/memory/lifecycle/delete.js", () => ({
  deleteRepoMemoryArtifacts: async () => ({ deletedWorktree: true, deletedMemoryDir: true }),
}));

vi.mock("@src/core/memory/lifecycle/cleanup.js", () => ({
  cleanupTestMemoryRuns: async () => ({ deletedRows: 0, deletedTranscriptDirs: 0, deletedMemoryDirs: 0 }),
}));

vi.mock("@src/db/repository.js", () => ({
  getPrSession: (...args: unknown[]) => mocks.getPrSession(...args),
  getPrSessionBySourceTask: (...args: unknown[]) => mocks.getPrSessionBySourceTask(...args),
  updatePrSession: async () => null,
  listTasks: async () => [],
  listPrSessions: async () => [],
  listPrSessionsForRepoAndPr: (...args: unknown[]) => mocks.listPrSessionsForRepoAndPr(...args),
  listTasksForRepoAndPr: (...args: unknown[]) => mocks.listTasksForRepoAndPr(...args),
  getRunsForPrSession: async () => [],
  listMemoryRuns: async () => [],
  getMemoryRun: async () => null,
  listTasksByRepo: async () => [],
  getTask: (...args: unknown[]) => mocks.getTask(...args),
  getStagesForTask: async () => [],
  updateTask: async () => undefined,
  deactivateMemoryRunsForRepo: async () => 0,
}));

vi.mock("@src/core/pi/session-file.js", () => ({
  readSessionFile: async () => [],
  taskSessionPath: () => "/tmp/task.session.jsonl",
  prSessionPath: () => "/tmp/pr.session.jsonl",
  watchSessionFile: () => () => undefined,
}));

vi.mock("@src/core/stage.js", () => ({
  cancelTask: () => undefined,
}));

vi.mock("@src/pipelines/coding/pipeline.js", () => ({
  runPipeline: async () => undefined,
}));

vi.mock("@src/pipelines/question/pipeline.js", () => ({
  runQuestion: async () => undefined,
}));

vi.mock("@src/pipelines/pr-review/pipeline.js", () => ({
  runPrReview: async () => undefined,
}));

vi.mock("@src/core/cleanup.js", () => ({
  dismissTask: async () => undefined,
}));

import { createApi } from "@src/api/index.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";

const validArtifact: PrReviewArtifact = {
  prTitle: "Add review page",
  headSha: "abc123456789",
  summary: "This review explains the PR.",
  visualSnapshot: { type: "skipped", reason: "no_frontend_changes" },
  chapters: [
    {
      id: "main-change",
      title: "Main change",
      narrative: "This group carries the core behavior.",
      files: [{ path: "src/a.ts", narrative: "This file carries the core behavior." }],
      annotations: [],
    },
  ],
};

function mkSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    repo: "goodboy",
    prNumber: 42,
    status: "active",
    watchStatus: "watching",
    branch: "goodboy/test",
    worktreePath: "/tmp/wt",
    mode: "review",
    sourceTaskId: TASK_ID,
    telegramChatId: null,
    lastPolledAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mkTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TASK_ID,
    repo: "goodboy",
    kind: "pr_review",
    description: "Review PR #42",
    status: "complete",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: 42,
    prIdentifier: "42",
    error: null,
    instance: "test",
    telegramChatId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: new Date(),
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getPrSession.mockResolvedValue(mkSession());
  mocks.getPrSessionBySourceTask.mockResolvedValue(null);
  mocks.getTask.mockResolvedValue(null);
  mocks.listPrSessionsForRepoAndPr.mockResolvedValue([]);
  mocks.listTasksForRepoAndPr.mockResolvedValue([]);
  await rm(taskArtifactsDir(TASK_ID), { recursive: true, force: true });
});

afterEach(async () => {
  await rm(taskArtifactsDir(TASK_ID), { recursive: true, force: true });
});

function prReviewTestPaths(artifactsDir: string) {
  return {
    review: prReviewOutputs.review.resolve(artifactsDir, undefined).path,
    updatedDiff: prReviewOutputs.updatedDiff.resolve(artifactsDir, undefined).path,
    diff: prReviewOutputs.diff.resolve(artifactsDir, undefined).path,
  };
}

describe("GET /api/tasks/:id/review", () => {
  it("returns 404 for invalid ids", async () => {
    const app = createApi();

    const res = await app.fetch(new Request("http://goodboy.test/api/tasks/not-a-uuid/review"));

    expect(res.status).toBe(404);
  });

  it("returns 404 for non-PR-review tasks", async () => {
    mocks.getTask.mockResolvedValue(mkTask({ kind: "coding_task" }));
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/tasks/${TASK_ID}/review`));

    expect(res.status).toBe(404);
  });

  it("returns run null when review.json is unavailable", async () => {
    mocks.getTask.mockResolvedValue(mkTask());
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/tasks/${TASK_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      task: { id: TASK_ID, kind: "pr_review", prNumber: 42 },
      session: null,
      run: null,
    });
  });

  it("resolves direct external review sessions by source task", async () => {
    mocks.getTask.mockResolvedValue(mkTask());
    mocks.getPrSessionBySourceTask.mockResolvedValue(mkSession());
    const paths = prReviewTestPaths(taskArtifactsDir(TASK_ID));
    await mkdir(path.dirname(paths.review), { recursive: true });
    await writeFile(paths.review, JSON.stringify(validArtifact), "utf8");
    await writeFile(paths.diff, "diff --git a/src/a.ts b/src/a.ts\n", "utf8");
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/tasks/${TASK_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      session: { id: SESSION_ID, mode: "review" },
      run: { prTitle: validArtifact.prTitle },
    });
  });

  it("resolves owned PR sessions by repo and PR number", async () => {
    mocks.getTask.mockResolvedValue(mkTask());
    mocks.listPrSessionsForRepoAndPr.mockResolvedValue([
      mkSession({ mode: "own", sourceTaskId: "33333333-3333-3333-3333-333333333333" }),
    ]);
    const paths = prReviewTestPaths(taskArtifactsDir(TASK_ID));
    await mkdir(path.dirname(paths.review), { recursive: true });
    await writeFile(paths.review, JSON.stringify(validArtifact), "utf8");
    await writeFile(paths.updatedDiff, "diff --git a/src/owned.ts b/src/owned.ts\n", "utf8");
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/tasks/${TASK_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      session: { id: SESSION_ID, mode: "own" },
      run: { diffPatch: "diff --git a/src/owned.ts b/src/owned.ts\n" },
    });
  });
});

describe("GET /api/pr-sessions/:id/review", () => {
  it("returns 404 for invalid ids", async () => {
    const app = createApi();

    const res = await app.fetch(new Request("http://goodboy.test/api/pr-sessions/not-a-uuid/review"));

    expect(res.status).toBe(404);
  });

  it("returns run null when the session has no source task", async () => {
    mocks.getPrSession.mockResolvedValue(mkSession({ sourceTaskId: null }));
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/pr-sessions/${SESSION_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      session: {
        id: SESSION_ID,
        prUrl: "https://github.com/acme/widgets/pull/42",
        mode: "review",
      },
      run: null,
    });
  });

  it("returns run null when review.json is unavailable", async () => {
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/pr-sessions/${SESSION_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ run: null });
  });

  it("returns the validated artifact with updated diff", async () => {
    const paths = prReviewTestPaths(taskArtifactsDir(TASK_ID));
    await mkdir(path.dirname(paths.review), { recursive: true });
    await writeFile(paths.review, JSON.stringify(validArtifact), "utf8");
    await writeFile(paths.updatedDiff, "diff --git a/src/a.ts b/src/a.ts\n", "utf8");
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/pr-sessions/${SESSION_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      run: {
        prTitle: validArtifact.prTitle,
        diffPatch: "diff --git a/src/a.ts b/src/a.ts\n",
      },
    });
  });

  it("falls back to the original diff when updated diff is missing", async () => {
    const paths = prReviewTestPaths(taskArtifactsDir(TASK_ID));
    await mkdir(config.artifactsDir, { recursive: true });
    await mkdir(path.dirname(paths.review), { recursive: true });
    await writeFile(paths.review, JSON.stringify(validArtifact), "utf8");
    await writeFile(paths.diff, "diff --git a/src/fallback.ts b/src/fallback.ts\n", "utf8");
    const app = createApi();

    const res = await app.fetch(new Request(`http://goodboy.test/api/pr-sessions/${SESSION_ID}/review`));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      run: { diffPatch: "diff --git a/src/fallback.ts b/src/fallback.ts\n" },
    });
  });
});
