import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrSession: vi.fn(),
  runReviewChatTurn: vi.fn(),
  readSessionFile: vi.fn(),
}));

vi.mock("@src/shared/repos.js", () => ({
  getRepo: () => null,
  listRepos: () => [],
  buildPrUrl: (_repo: string, _prNumber: number | null) => null,
}));

vi.mock("@src/core/memory/index.js", () => ({
  memoryStatus: async () => ({ state: null, fileCount: 0, totalBytes: 0 }),
  currentHeadSha: async () => "head",
  tryAcquireLock: async () => true,
  releaseLock: async () => undefined,
}));

vi.mock("@src/core/memory/delete.js", () => ({
  deleteRepoMemoryArtifacts: async () => ({ deletedWorktree: true, deletedMemoryDir: true }),
}));

vi.mock("@src/core/memory/cleanup.js", () => ({
  cleanupTestMemoryRuns: async () => ({ deletedRows: 0, deletedTranscriptDirs: 0, deletedMemoryDirs: 0 }),
}));

vi.mock("@src/db/repository.js", () => ({
  getPrSession: (...args: unknown[]) => mocks.getPrSession(...args),
  updatePrSession: async () => null,
  listTasks: async () => [],
  listPrSessions: async () => [],
  getRunsForPrSession: async () => [],
  listMemoryRuns: async () => [],
  getMemoryRun: async () => null,
  getTask: async () => null,
  getStagesForTask: async () => [],
  updateTask: async () => undefined,
  deactivateMemoryRunsForRepo: async () => 0,
}));

vi.mock("@src/core/pi/session-file.js", () => ({
  readSessionFile: (...args: unknown[]) => mocks.readSessionFile(...args),
  taskSessionPath: () => "/tmp/task.session.jsonl",
  prSessionPath: () => "/tmp/pr.session.jsonl",
  watchSessionFile: () => () => undefined,
}));

vi.mock("@src/core/stage.js", () => ({
  cancelTask: () => undefined,
}));

vi.mock("@src/pipelines/coding/pipeline.js", () => ({ runPipeline: async () => undefined }));
vi.mock("@src/pipelines/question/pipeline.js", () => ({ runQuestion: async () => undefined }));
vi.mock("@src/pipelines/pr-review/pipeline.js", () => ({ runPrReview: async () => undefined }));
vi.mock("@src/core/cleanup.js", () => ({ dismissTask: async () => undefined }));

vi.mock("@src/pipelines/pr-session/session.js", async () => {
  class ReviewChatBusyError extends Error {
    constructor() { super("goodboy is already working on this PR"); this.name = "ReviewChatBusyError"; }
  }
  class ReviewChatUnavailableError extends Error {
    constructor(message: string) { super(message); this.name = "ReviewChatUnavailableError"; }
  }
  return {
    runReviewChatTurn: (...args: unknown[]) => mocks.runReviewChatTurn(...args),
    ReviewChatBusyError,
    ReviewChatUnavailableError,
  };
});

import { createApi } from "@src/api/index.js";
import {
  ReviewChatBusyError,
  ReviewChatUnavailableError,
} from "@src/pipelines/pr-session/session.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const TASK_ID = "22222222-2222-2222-2222-222222222222";

function mkSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ID,
    repo: "goodboy",
    prNumber: 42,
    status: "active",
    watchStatus: "watching",
    branch: "feat/x",
    worktreePath: "/tmp/wt",
    mode: "review",
    sourceTaskId: TASK_ID,
    telegramChatId: null,
    lastPolledAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPrSession.mockResolvedValue(mkSession());
  mocks.readSessionFile.mockResolvedValue([]);
});

describe("GET /api/pr-sessions/:id/review-chat", () => {
  it("returns 404 for invalid ids", async () => {
    const res = await createApi().fetch(new Request("http://t/api/pr-sessions/not-a-uuid/review-chat"));
    expect(res.status).toBe(404);
  });

  it("returns unavailable for non-review sessions", async () => {
    mocks.getPrSession.mockResolvedValue(mkSession({ mode: "own" }));
    const res = await createApi().fetch(new Request(`http://t/api/pr-sessions/${SESSION_ID}/review-chat`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      available: false,
      reason: expect.stringMatching(/reviewed PRs/i),
      messages: [],
    });
  });

  it("returns available with extracted messages for ready sessions", async () => {
    const res = await createApi().fetch(new Request(`http://t/api/pr-sessions/${SESSION_ID}/review-chat`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      available: true,
      reason: null,
      messages: [],
    });
  });
});

describe("POST /api/pr-sessions/:id/review-chat", () => {
  function postBody(body: unknown): Promise<Response> {
    return createApi().fetch(new Request(`http://t/api/pr-sessions/${SESSION_ID}/review-chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  it("rejects invalid bodies with 400", async () => {
    const res = await postBody({ message: "" });
    expect(res.status).toBe(400);
  });

  it("returns 409 for non-review sessions", async () => {
    mocks.getPrSession.mockResolvedValue(mkSession({ mode: "own" }));
    mocks.runReviewChatTurn.mockRejectedValue(new ReviewChatUnavailableError("Review chat is available for reviewed PRs only."));
    const res = await postBody({ message: "hi", activeFile: null, annotation: null });
    expect(res.status).toBe(409);
  });

  it("returns 409 when busy", async () => {
    mocks.runReviewChatTurn.mockRejectedValue(new ReviewChatBusyError());
    const res = await postBody({ message: "hi", activeFile: null, annotation: null });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringMatching(/already working/i) });
  });

  it("returns reply and changed when the turn completes", async () => {
    mocks.runReviewChatTurn.mockResolvedValue({ status: "complete", reply: "Pushed the fix.", changed: true });
    const res = await postBody({ message: "fix it", activeFile: "src/a.ts", annotation: null });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      reply: "Pushed the fix.",
      changed: true,
      messages: [],
    });
    expect(mocks.runReviewChatTurn).toHaveBeenCalledWith({
      prSessionId: SESSION_ID,
      message: "fix it",
      activeFile: "src/a.ts",
      annotation: null,
    });
  });

  it("returns 500 for unexpected runner failures", async () => {
    mocks.runReviewChatTurn.mockRejectedValue(new Error("boom"));
    const res = await postBody({ message: "hi", activeFile: null, annotation: null });
    expect(res.status).toBe(500);
  });
});
