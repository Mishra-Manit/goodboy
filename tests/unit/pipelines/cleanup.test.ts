import { describe, it, expect, vi, beforeEach } from "vitest";

// Plain-handler pattern (vi.fn spies and rejected promises don't play nicely
// with vitest 4; see github.io.test.ts for the same workaround).
const { execHandler, worktreeHandler, fsHandler, queriesHandler, eventsHandler } = vi.hoisted(() => ({
  execHandler: {
    calls: [] as Array<readonly unknown[]>,
    impl: async (_cmd: string, _args: readonly string[]) => ({ stdout: "", stderr: "" }),
  },
  worktreeHandler: {
    calls: [] as Array<readonly unknown[]>,
    impl: async (_repo: string, _worktree: string) => undefined,
  },
  fsHandler: {
    calls: [] as Array<readonly unknown[]>,
    impl: async (_path: string, _opts: unknown) => undefined,
  },
  queriesHandler: {
    getTask:                  { calls: [] as unknown[][], impl: async (_id: string): Promise<unknown> => null },
    getPrSession:             { calls: [] as unknown[][], impl: async (_id: string): Promise<unknown> => null },
    getPrSessionBySourceTask: { calls: [] as unknown[][], impl: async (_id: string): Promise<unknown> => null },
    updateTask:               { calls: [] as unknown[][], impl: async (_id: string, _d: unknown): Promise<void> => undefined },
    updatePrSession:          { calls: [] as unknown[][], impl: async (_id: string, _d: unknown): Promise<void> => undefined },
  },
  eventsHandler: {
    emitted: [] as unknown[],
  },
}));

vi.mock("node:child_process", () => {
  // vi.mock factories are hoisted before any imports resolve, so static
  // `import` is unavailable here. `require()` is the only synchronous
  // escape hatch for accessing already-loaded modules.
  const { promisify } = require("node:util") as typeof import("node:util");
  const execFile = (cmd: string, args: readonly string[]) => {
    execHandler.calls.push([cmd, args]);
    return execHandler.impl(cmd, args);
  };
  (execFile as unknown as { [k: symbol]: unknown })[promisify.custom] = execFile;
  return { execFile };
});

vi.mock("node:fs/promises", async (orig) => {
  const actual = await orig<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: (p: string, opts: unknown) => {
      fsHandler.calls.push([p, opts]);
      return fsHandler.impl(p, opts);
    },
  };
});

vi.mock("@src/core/git/worktree.js", () => ({
  removeWorktree: (repoPath: string, worktreePath: string) => {
    worktreeHandler.calls.push([repoPath, worktreePath]);
    return worktreeHandler.impl(repoPath, worktreePath);
  },
}));

vi.mock("@src/core/pi/session-file.js", () => ({
  prSessionPath: (id: string) => `/tmp/goodboy-pr-sessions/${id}.session/${id}.jsonl`,
}));

vi.mock("@src/db/repository.js", () => ({
  getTask: (id: string) => {
    queriesHandler.getTask.calls.push([id]);
    return queriesHandler.getTask.impl(id);
  },
  getPrSession: (id: string) => {
    queriesHandler.getPrSession.calls.push([id]);
    return queriesHandler.getPrSession.impl(id);
  },
  getPrSessionBySourceTask: (id: string) => {
    queriesHandler.getPrSessionBySourceTask.calls.push([id]);
    return queriesHandler.getPrSessionBySourceTask.impl(id);
  },
  updateTask: (id: string, data: unknown) => {
    queriesHandler.updateTask.calls.push([id, data]);
    return queriesHandler.updateTask.impl(id, data);
  },
  updatePrSession: (id: string, data: unknown) => {
    queriesHandler.updatePrSession.calls.push([id, data]);
    return queriesHandler.updatePrSession.impl(id, data);
  },
}));

vi.mock("@src/shared/runtime/events.js", () => ({
  emit: (event: unknown) => {
    eventsHandler.emitted.push(event);
  },
}));

import { dismissTask, cleanupTaskResources, cleanupPrSession } from "@src/core/cleanup.js";

function mkTask(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "t1",
    repo: "myrepo",
    status: "complete",
    kind: "coding_task",
    description: "x",
    prNumber: null,
    prUrl: null,
    worktreePath: null,
    branch: null,
    ...overrides,
  };
}

function mkPrSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "ps1",
    repo: "myrepo",
    status: "open",
    worktreePath: "/tmp/wt",
    branch: "goodboy/x",
    sourceTaskId: null,
    mode: "own",
    ...overrides,
  };
}

beforeEach(() => {
  execHandler.calls.length = 0;
  execHandler.impl = async () => ({ stdout: "", stderr: "" });
  worktreeHandler.calls.length = 0;
  worktreeHandler.impl = async () => undefined;
  fsHandler.calls.length = 0;
  fsHandler.impl = async () => undefined;
  for (const h of Object.values(queriesHandler)) {
    h.calls.length = 0;
  }
  queriesHandler.getTask.impl = async () => null;
  queriesHandler.getPrSession.impl = async () => null;
  queriesHandler.getPrSessionBySourceTask.impl = async () => null;
  queriesHandler.updateTask.impl = async () => undefined;
  queriesHandler.updatePrSession.impl = async () => undefined;
  eventsHandler.emitted.length = 0;
});

describe("dismissTask", () => {
  it("throws when the task does not exist", async () => {
    await expect(dismissTask("missing")).rejects.toThrow(/not found/);
  });

  it("throws when the task is still running", async () => {
    queriesHandler.getTask.impl = async () => mkTask({ status: "running" });
    await expect(dismissTask("t1")).rejects.toThrow(/cancel it first/);
  });

  it("throws when the task is queued", async () => {
    queriesHandler.getTask.impl = async () => mkTask({ status: "queued" });
    await expect(dismissTask("t1")).rejects.toThrow(/cancel it first/);
  });

  it("closes the PR when prNumber + repo.githubUrl are present", async () => {
    queriesHandler.getTask.impl = async () =>
      mkTask({ status: "complete", prNumber: 42, worktreePath: "/tmp/wt", branch: "goodboy/x" });
    await dismissTask("t1");
    const closeCall = execHandler.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("close"),
    );
    expect(closeCall).toBeDefined();
    expect(closeCall?.[1]).toContain("42");
  });

  it("removes worktree and marks the task cancelled with cleared metadata", async () => {
    queriesHandler.getTask.impl = async () =>
      mkTask({ status: "complete", worktreePath: "/tmp/wt", branch: "goodboy/x" });
    await dismissTask("t1");

    expect(worktreeHandler.calls).toHaveLength(1);
    expect(worktreeHandler.calls[0][1]).toBe("/tmp/wt");

    const update = queriesHandler.updateTask.calls[0];
    expect(update[0]).toBe("t1");
    expect(update[1]).toMatchObject({
      status: "cancelled",
      prUrl: null,
      prNumber: null,
      worktreePath: null,
      branch: null,
    });

    expect(eventsHandler.emitted[0]).toEqual({
      type: "task_update",
      taskId: "t1",
      status: "cancelled",
    });
  });

  it("delegates to PR-session cleanup when one exists for the task", async () => {
    queriesHandler.getTask.impl = async () =>
      mkTask({ status: "complete", worktreePath: "/tmp/task-wt", branch: "goodboy/x" });
    queriesHandler.getPrSessionBySourceTask.impl = async () =>
      mkPrSession({ id: "ps1", worktreePath: "/tmp/pr-wt", branch: "goodboy/x" });
    queriesHandler.getPrSession.impl = async () =>
      mkPrSession({ id: "ps1", worktreePath: "/tmp/pr-wt", branch: "goodboy/x" });

    await dismissTask("t1");

    // Worktree removal came from the PR-session cleanup path, not the task path.
    expect(worktreeHandler.calls.some((c) => c[1] === "/tmp/pr-wt")).toBe(true);
    expect(worktreeHandler.calls.every((c) => c[1] !== "/tmp/task-wt")).toBe(true);
    // PR session status flipped to closed.
    const prUpdate = queriesHandler.updatePrSession.calls[0];
    expect(prUpdate[1]).toMatchObject({ status: "closed", worktreePath: null, branch: null });
  });

  it("never closes the upstream PR or remote branch for pr_review tasks", async () => {
    queriesHandler.getTask.impl = async () =>
      mkTask({ kind: "pr_review", status: "complete", prNumber: 99, worktreePath: "/tmp/wt" });
    await dismissTask("t1");
    const closeCall = execHandler.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("close"),
    );
    expect(closeCall).toBeUndefined();
  });

  it("proceeds without git cleanup when the repo is not in the registry", async () => {
    queriesHandler.getTask.impl = async () =>
      mkTask({ repo: "ghost", status: "complete", worktreePath: "/tmp/wt" });
    await dismissTask("t1");
    // No removeWorktree calls because repo lookup returned null.
    expect(worktreeHandler.calls).toHaveLength(0);
    // Task still marked cancelled.
    expect(queriesHandler.updateTask.calls[0][1]).toMatchObject({ status: "cancelled" });
  });
});

describe("cleanupTaskResources", () => {
  it("is a no-op when the task is missing", async () => {
    queriesHandler.getTask.impl = async () => null;
    await cleanupTaskResources("nope");
    expect(worktreeHandler.calls).toHaveLength(0);
    expect(queriesHandler.updateTask.calls).toHaveLength(0);
  });

  it("removes worktree and clears metadata when the task exists", async () => {
    queriesHandler.getTask.impl = async () =>
      mkTask({ worktreePath: "/tmp/wt", branch: "goodboy/x" });
    await cleanupTaskResources("t1");
    expect(worktreeHandler.calls).toHaveLength(1);
    expect(queriesHandler.updateTask.calls[0][1]).toEqual({
      worktreePath: null,
      branch: null,
    });
  });
});

describe("cleanupPrSession", () => {
  it("is a no-op when the session is missing", async () => {
    queriesHandler.getPrSession.impl = async () => null;
    await cleanupPrSession("nope");
    expect(queriesHandler.updatePrSession.calls).toHaveLength(0);
  });

  it("removes worktree, deletes session file, and marks closed", async () => {
    queriesHandler.getPrSession.impl = async () =>
      mkPrSession({ worktreePath: "/tmp/wt", branch: "goodboy/x" });
    await cleanupPrSession("ps1");

    expect(worktreeHandler.calls).toHaveLength(1);
    expect(fsHandler.calls).toHaveLength(1);
    expect(fsHandler.calls[0]).toEqual([
      "/tmp/goodboy-pr-sessions/ps1.session",
      { recursive: true, force: true },
    ]);
    expect(queriesHandler.updatePrSession.calls[0][1]).toMatchObject({
      status: "closed",
      worktreePath: null,
      branch: null,
    });
  });

  it("also clears source-task metadata when present", async () => {
    queriesHandler.getPrSession.impl = async () =>
      mkPrSession({ worktreePath: "/tmp/wt", sourceTaskId: "source-1" });
    await cleanupPrSession("ps1");
    const taskUpdate = queriesHandler.updateTask.calls.find((c) => c[0] === "source-1");
    expect(taskUpdate).toBeDefined();
    expect(taskUpdate?.[1]).toEqual({ worktreePath: null, branch: null });
  });
});
