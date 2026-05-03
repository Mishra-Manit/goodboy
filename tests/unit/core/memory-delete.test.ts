import { beforeEach, describe, expect, it, vi } from "vitest";

const { execState, existingPaths, rmState } = vi.hoisted(() => ({
  execState: {
    calls: [] as Array<{ file: string; args: string[]; cwd: string | undefined }> ,
    impl: (
      _file: string,
      _args: string[],
      _opts: { cwd?: string },
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => cb(null, "", ""),
  },
  existingPaths: new Set<string>(),
  rmState: {
    calls: [] as string[],
  },
}));

vi.mock("node:child_process", () => ({
  execFile: (
    file: string,
    args: string[],
    opts: { cwd?: string },
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    execState.calls.push({ file, args, cwd: opts?.cwd });
    execState.impl(file, args, opts, cb);
  },
}));

vi.mock("node:fs", () => ({
  existsSync: (target: string) => existingPaths.has(target),
}));

vi.mock("node:fs/promises", () => ({
  rm: async (target: string) => {
    rmState.calls.push(target);
    existingPaths.delete(target);
  },
}));

vi.mock("@src/core/memory/index.js", () => ({
  memoryDir: (repo: string) => `/artifacts/memory-test-${repo}`,
  memoryWorktreeDir: (repo: string) => `/artifacts/memory-test-${repo}/checkout`,
}));

import { deleteRepoMemoryArtifacts } from "@src/core/memory/lifecycle/delete.js";

beforeEach(() => {
  execState.calls = [];
  execState.impl = (_file, _args, _opts, cb) => cb(null, "", "");
  existingPaths.clear();
  rmState.calls = [];
});

describe("deleteRepoMemoryArtifacts", () => {
  it("prunes, removes the worktree, prunes again, then deletes the parent memory dir", async () => {
    existingPaths.add("/artifacts/memory-test-coliseum");
    existingPaths.add("/artifacts/memory-test-coliseum/checkout");

    const result = await deleteRepoMemoryArtifacts("coliseum", "/repos/coliseum");

    expect(execState.calls).toEqual([
      { file: "git", args: ["worktree", "prune"], cwd: "/repos/coliseum" },
      {
        file: "git",
        args: ["worktree", "remove", "--force", "/artifacts/memory-test-coliseum/checkout"],
        cwd: "/repos/coliseum",
      },
      { file: "git", args: ["worktree", "prune"], cwd: "/repos/coliseum" },
    ]);
    expect(rmState.calls).toEqual(["/artifacts/memory-test-coliseum"]);
    expect(result).toEqual({
      deletedWorktree: true,
      deletedMemoryDir: true,
      memoryDirPath: "/artifacts/memory-test-coliseum",
      worktreePath: "/artifacts/memory-test-coliseum/checkout",
    });
  });

  it("falls back to rm + prune when git worktree remove fails", async () => {
    existingPaths.add("/artifacts/memory-test-coliseum");
    existingPaths.add("/artifacts/memory-test-coliseum/checkout");

    execState.impl = (_file, args, _opts, cb) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        cb(new Error("remove failed"), "", "");
        return;
      }
      cb(null, "", "");
    };

    const result = await deleteRepoMemoryArtifacts("coliseum", "/repos/coliseum");

    expect(rmState.calls).toEqual([
      "/artifacts/memory-test-coliseum/checkout",
      "/artifacts/memory-test-coliseum",
    ]);
    expect(result.deletedWorktree).toBe(true);
    expect(result.deletedMemoryDir).toBe(true);
  });

  it("stays idempotent when the repo has no current memory artifacts", async () => {
    const result = await deleteRepoMemoryArtifacts("coliseum", "/repos/coliseum");

    expect(execState.calls).toEqual([
      { file: "git", args: ["worktree", "prune"], cwd: "/repos/coliseum" },
      { file: "git", args: ["worktree", "prune"], cwd: "/repos/coliseum" },
    ]);
    expect(rmState.calls).toEqual(["/artifacts/memory-test-coliseum"]);
    expect(result).toEqual({
      deletedWorktree: false,
      deletedMemoryDir: false,
      memoryDirPath: "/artifacts/memory-test-coliseum",
      worktreePath: "/artifacts/memory-test-coliseum/checkout",
    });
  });
});
