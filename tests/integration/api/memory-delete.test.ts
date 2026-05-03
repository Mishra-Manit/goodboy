import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getRepo: vi.fn(),
  tryAcquireLock: vi.fn(),
  releaseLock: vi.fn(),
  deleteRepoMemoryArtifacts: vi.fn(),
  deactivateMemoryRunsForRepo: vi.fn(),
}));

vi.mock("@src/shared/domain/repos.js", () => ({
  getRepo: (...args: unknown[]) => mocks.getRepo(...args),
  listRepos: () => [],
  buildPrUrl: () => null,
}));

vi.mock("@src/core/memory/index.js", () => ({
  memoryStatus: async () => ({ state: null, fileCount: 0, totalBytes: 0 }),
  currentHeadSha: async () => "head-sha",
  tryAcquireLock: (...args: unknown[]) => mocks.tryAcquireLock(...args),
  releaseLock: (...args: unknown[]) => mocks.releaseLock(...args),
}));

vi.mock("@src/core/memory/lifecycle/delete.js", () => ({
  deleteRepoMemoryArtifacts: (...args: unknown[]) => mocks.deleteRepoMemoryArtifacts(...args),
}));

vi.mock("@src/core/memory/lifecycle/cleanup.js", () => ({
  cleanupTestMemoryRuns: async () => ({ deletedRows: 0, deletedTranscriptDirs: 0, deletedMemoryDirs: 0 }),
}));

vi.mock("@src/db/repository.js", () => ({
  deactivateMemoryRunsForRepo: (...args: unknown[]) => mocks.deactivateMemoryRunsForRepo(...args),
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRepo.mockReturnValue({ name: "coliseum", localPath: "/repos/coliseum" });
  mocks.tryAcquireLock.mockResolvedValue(true);
  mocks.releaseLock.mockResolvedValue(undefined);
  mocks.deleteRepoMemoryArtifacts.mockResolvedValue({
    deletedWorktree: true,
    deletedMemoryDir: true,
    memoryDirPath: "/artifacts/memory-test-coliseum",
    worktreePath: "/artifacts/memory-test-coliseum/checkout",
  });
  mocks.deactivateMemoryRunsForRepo.mockResolvedValue(2);
});

describe("DELETE /api/memory/repo/:repo", () => {
  it("returns 404 for an unknown repo", async () => {
    mocks.getRepo.mockReturnValue(null);
    const app = createApi();

    const res = await app.fetch(new Request("http://goodboy.test/api/memory/repo/unknown", {
      method: "DELETE",
    }));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "unknown repo" });
    expect(mocks.tryAcquireLock).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("returns 409 when a memory run already holds the lock", async () => {
    mocks.tryAcquireLock.mockResolvedValue(false);
    const app = createApi();

    const res = await app.fetch(new Request("http://goodboy.test/api/memory/repo/coliseum", {
      method: "DELETE",
    }));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: "memory delete blocked by active run" });
    expect(mocks.deleteRepoMemoryArtifacts).not.toHaveBeenCalled();
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it("deletes artifacts, deactivates runs, and releases the lock", async () => {
    const app = createApi();

    const res = await app.fetch(new Request("http://goodboy.test/api/memory/repo/coliseum", {
      method: "DELETE",
    }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      repo: "coliseum",
      deletedWorktree: true,
      deletedMemoryDir: true,
      deactivatedRuns: 2,
    });
    expect(mocks.tryAcquireLock).toHaveBeenCalledWith("coliseum", expect.stringContaining("memory-delete-coliseum-"));
    expect(mocks.deleteRepoMemoryArtifacts).toHaveBeenCalledWith("coliseum", "/repos/coliseum");
    expect(mocks.deactivateMemoryRunsForRepo).toHaveBeenCalledWith("coliseum");
    expect(mocks.releaseLock).toHaveBeenCalledWith("coliseum");
  });

  it("returns 500 and still releases the lock when deletion fails", async () => {
    mocks.deleteRepoMemoryArtifacts.mockRejectedValue(new Error("delete exploded"));
    const app = createApi();

    const res = await app.fetch(new Request("http://goodboy.test/api/memory/repo/coliseum", {
      method: "DELETE",
    }));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "delete exploded" });
    expect(mocks.deactivateMemoryRunsForRepo).not.toHaveBeenCalled();
    expect(mocks.releaseLock).toHaveBeenCalledWith("coliseum");
  });
});
