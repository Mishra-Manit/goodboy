import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPrSession: vi.fn(),
  updatePrSession: vi.fn(),
}));

vi.mock("@src/shared/repos.js", () => ({
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

vi.mock("@src/core/memory/delete.js", () => ({
  deleteRepoMemoryArtifacts: async () => ({ deletedWorktree: true, deletedMemoryDir: true }),
}));

vi.mock("@src/core/memory/cleanup.js", () => ({
  cleanupTestMemoryRuns: async () => ({ deletedRows: 0, deletedTranscriptDirs: 0, deletedMemoryDirs: 0 }),
}));

vi.mock("@src/db/repository.js", () => ({
  getPrSession: (...args: unknown[]) => mocks.getPrSession(...args),
  updatePrSession: (...args: unknown[]) => mocks.updatePrSession(...args),
  listTasks: async () => [],
  listPrSessions: async () => [],
  getRunsForPrSession: async () => [],
  listMemoryRuns: async () => [],
  getMemoryRun: async () => null,
  listTasksByRepo: async () => [],
  getTask: async () => null,
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

function mkSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    repo: "goodboy",
    prNumber: 42,
    status: "active",
    watchStatus: "watching",
    branch: "goodboy/test",
    worktreePath: "/tmp/wt",
    mode: "own",
    sourceTaskId: null,
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
  mocks.updatePrSession.mockImplementation(async (_id: string, data: Record<string, unknown>) => {
    return mkSession(data);
  });
});

describe("POST /api/pr-sessions/:id/watch", () => {
  it("returns 404 when the session does not exist", async () => {
    mocks.getPrSession.mockResolvedValue(null);
    const app = createApi();

    const res = await app.fetch(new Request(
      "http://goodboy.test/api/pr-sessions/11111111-1111-1111-1111-111111111111/watch",
      {
        method: "POST",
        body: JSON.stringify({ watchStatus: "muted" }),
        headers: { "Content-Type": "application/json" },
      },
    ));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Not found" });
  });

  it("returns 400 for an invalid watch status", async () => {
    const app = createApi();

    const res = await app.fetch(new Request(
      "http://goodboy.test/api/pr-sessions/11111111-1111-1111-1111-111111111111/watch",
      {
        method: "POST",
        body: JSON.stringify({ watchStatus: "nope" }),
        headers: { "Content-Type": "application/json" },
      },
    ));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid watchStatus" });
    expect(mocks.updatePrSession).not.toHaveBeenCalled();
  });

  it("updates watchStatus and advances the poll cursor", async () => {
    const app = createApi();

    const res = await app.fetch(new Request(
      "http://goodboy.test/api/pr-sessions/11111111-1111-1111-1111-111111111111/watch",
      {
        method: "POST",
        body: JSON.stringify({ watchStatus: "muted" }),
        headers: { "Content-Type": "application/json" },
      },
    ));

    expect(res.status).toBe(200);
    expect(mocks.updatePrSession).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      {
        watchStatus: "muted",
        lastPolledAt: expect.any(Date),
      },
    );
    await expect(res.json()).resolves.toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      watchStatus: "muted",
      prUrl: "https://github.com/acme/widgets/pull/42",
    });
  });
});
