import { beforeEach, describe, expect, it, vi } from "vitest";

const { queriesHandler, githubHandler, sessionHandler, cleanupHandler } = vi.hoisted(() => ({
  queriesHandler: {
    listActivePrSessions: vi.fn(),
    updatePrSession: vi.fn(),
  },
  githubHandler: {
    isPrClosed: vi.fn(),
    getPrComments: vi.fn(),
    getPrReviewComments: vi.fn(),
    getPrReviews: vi.fn(),
  },
  sessionHandler: {
    resumePrSession: vi.fn(),
  },
  cleanupHandler: {
    cleanupPrSession: vi.fn(),
  },
}));

vi.mock("@src/db/repository.js", () => ({
  listActivePrSessions: (...args: unknown[]) => queriesHandler.listActivePrSessions(...args),
  updatePrSession: (...args: unknown[]) => queriesHandler.updatePrSession(...args),
}));

vi.mock("@src/core/git/github.js", () => ({
  isPrClosed: (...args: unknown[]) => githubHandler.isPrClosed(...args),
  getPrComments: (...args: unknown[]) => githubHandler.getPrComments(...args),
  getPrReviewComments: (...args: unknown[]) => githubHandler.getPrReviewComments(...args),
  getPrReviews: (...args: unknown[]) => githubHandler.getPrReviews(...args),
}));

vi.mock("@src/pipelines/pr-session/session.js", () => ({
  resumePrSession: (...args: unknown[]) => sessionHandler.resumePrSession(...args),
}));

vi.mock("@src/core/cleanup.js", () => ({
  cleanupPrSession: (...args: unknown[]) => cleanupHandler.cleanupPrSession(...args),
}));

vi.mock("@src/shared/repos.js", () => ({
  getRepoNwo: () => "acme/widgets",
}));

import { pollOnce } from "@src/pipelines/pr-session/poller.js";

function mkSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ps1",
    repo: "goodboy",
    prNumber: 42,
    status: "active",
    watchStatus: "watching",
    lastPolledAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queriesHandler.listActivePrSessions.mockResolvedValue([]);
  queriesHandler.updatePrSession.mockResolvedValue(undefined);
  githubHandler.isPrClosed.mockResolvedValue(false);
  githubHandler.getPrComments.mockResolvedValue([]);
  githubHandler.getPrReviewComments.mockResolvedValue([]);
  githubHandler.getPrReviews.mockResolvedValue([]);
  sessionHandler.resumePrSession.mockResolvedValue(undefined);
  cleanupHandler.cleanupPrSession.mockResolvedValue(undefined);
});

describe("pollOnce", () => {
  it("skips comment fetching and resume for muted sessions", async () => {
    queriesHandler.listActivePrSessions.mockResolvedValue([mkSession({ watchStatus: "muted" })]);

    await pollOnce(async () => undefined);

    expect(githubHandler.isPrClosed).toHaveBeenCalledWith("acme/widgets", 42);
    expect(githubHandler.getPrComments).not.toHaveBeenCalled();
    expect(githubHandler.getPrReviewComments).not.toHaveBeenCalled();
    expect(sessionHandler.resumePrSession).not.toHaveBeenCalled();
    expect(queriesHandler.updatePrSession).not.toHaveBeenCalled();
  });

  it("still cleans up a muted session when the PR is closed", async () => {
    queriesHandler.listActivePrSessions.mockResolvedValue([mkSession({ watchStatus: "muted" })]);
    githubHandler.isPrClosed.mockResolvedValue(true);

    await pollOnce(async () => undefined);

    expect(cleanupHandler.cleanupPrSession).toHaveBeenCalledWith("ps1");
    expect(githubHandler.getPrComments).not.toHaveBeenCalled();
    expect(sessionHandler.resumePrSession).not.toHaveBeenCalled();
  });

  it("resumes watching sessions when new comments arrive", async () => {
    const comment = {
      kind: "conversation" as const,
      id: "c1",
      author: "manit",
      body: "please fix this",
      createdAt: "2026-04-25T12:00:00.000Z",
    };
    queriesHandler.listActivePrSessions.mockResolvedValue([
      mkSession({ watchStatus: "watching", lastPolledAt: new Date("2026-04-25T11:00:00.000Z") }),
    ]);
    githubHandler.getPrComments.mockResolvedValue([comment]);

    await pollOnce(async () => undefined);

    expect(githubHandler.getPrComments).toHaveBeenCalledWith("acme/widgets", 42);
    expect(githubHandler.getPrReviewComments).toHaveBeenCalledWith("acme/widgets", 42);
    expect(githubHandler.getPrReviews).toHaveBeenCalledWith("acme/widgets", 42);
    expect(sessionHandler.resumePrSession).toHaveBeenCalledWith({
      prSessionId: "ps1",
      comments: [comment],
      sendTelegram: expect.any(Function),
    });
  });

  it("advances lastPolledAt with a safety rewind when comments arrive", async () => {
    queriesHandler.listActivePrSessions.mockResolvedValue([
      mkSession({ lastPolledAt: new Date("2026-04-25T11:00:00.000Z") }),
    ]);
    githubHandler.getPrComments.mockResolvedValue([
      { kind: "conversation", id: "c1", author: "manit", body: "x", createdAt: "2026-04-25T12:00:00.000Z" },
    ]);

    const before = Date.now();
    await pollOnce(async () => undefined);
    const after = Date.now();

    const update = queriesHandler.updatePrSession.mock.calls.at(-1);
    expect(update?.[0]).toBe("ps1");
    const cursor = (update?.[1] as { lastPolledAt: Date }).lastPolledAt;
    // Cursor lives in [pollStart - 5s, now]; we just bound it loosely.
    expect(cursor.getTime()).toBeLessThanOrEqual(after);
    expect(cursor.getTime()).toBeGreaterThanOrEqual(before - 6_000);
  });

  it("updates lastPolledAt when no new comments are found", async () => {
    queriesHandler.listActivePrSessions.mockResolvedValue([mkSession()]);

    await pollOnce(async () => undefined);

    expect(queriesHandler.updatePrSession).toHaveBeenCalledWith("ps1", {
      lastPolledAt: expect.any(Date),
    });
  });
});
