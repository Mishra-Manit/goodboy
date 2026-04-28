import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

// Mock execFile so gh is never actually spawned. Node's real execFile
// carries a `util.promisify.custom` symbol, which makes `promisify(execFile)`
// return a ChildProcess-wrapping promise instead of using the plain Node
// callback contract. We attach the same symbol to the module-level handler
// so every call goes through one controllable async path, and keep a
// separate `calls[]` array for assertions (rather than relying on a vi.fn
// spy, which reports its own rejected results as unhandled).
const { handler } = vi.hoisted(() => {
  const h: {
    calls: Array<readonly unknown[]>;
    impl: (cmd: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
    invoke: (cmd: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
  } = {
    calls: [],
    impl: async () => ({ stdout: "", stderr: "" }),
    invoke(cmd, args) {
      this.calls.push([cmd, args]);
      return this.impl(cmd, args);
    },
  };
  return { handler: h };
});

vi.mock("node:child_process", () => {
  // vi.mock factories are hoisted before any imports resolve, so static
  // `import` is unavailable here. `require()` is the only synchronous
  // escape hatch for accessing already-loaded modules.
  const { promisify } = require("node:util") as typeof import("node:util");
  const execFile = (cmd: string, args: readonly string[]) => handler.invoke(cmd, args);
  (execFile as unknown as { [k: symbol]: unknown })[promisify.custom] = execFile;
  return { execFile };
});

import { getPrComments, getPrReviewComments, isPrClosed } from "@src/core/git/github.js";

function stubExecOk(stdout: string) {
  handler.impl = async () => ({ stdout, stderr: "" });
}

function stubExecThrow() {
  handler.impl = async () => {
    throw new Error("gh blew up");
  };
}

beforeEach(() => {
  handler.calls.length = 0;
  handler.impl = async () => ({ stdout: "", stderr: "" });
});

describe("getPrComments", () => {
  it("returns parsed issue comments from gh pr view", async () => {
    stubExecOk(await readFile("tests/fixtures/gh/pr-view-comments.json", "utf-8"));
    const out = await getPrComments("foo/bar", 1);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ author: "alice", body: "lgtm" });
    expect(out[1].author).toBe("bob");
  });

  it("returns [] when gh throws", async () => {
    stubExecThrow();
    expect(await getPrComments("foo/bar", 1)).toEqual([]);
  });

  it("returns [] when stdout is malformed JSON", async () => {
    stubExecOk("not json at all");
    expect(await getPrComments("foo/bar", 1)).toEqual([]);
  });

  it("invokes gh with the expected argv", async () => {
    stubExecOk(JSON.stringify({ comments: [] }));
    await getPrComments("foo/bar", 42);
    const call = handler.calls[0];
    expect(call[0]).toBe("gh");
    expect(call[1]).toEqual([
      "pr",
      "view",
      "42",
      "--repo",
      "foo/bar",
      "--json",
      "comments",
    ]);
  });
});

describe("getPrReviewComments", () => {
  it("returns parsed inline review comments with path + line", async () => {
    stubExecOk(await readFile("tests/fixtures/gh/pr-comments-api.json", "utf-8"));
    const out = await getPrReviewComments("foo/bar", 1);
    expect(out[0]).toMatchObject({
      author: "alice",
      path: "src/core/worktree.ts",
      line: 42,
    });
    // Second comment has line: null in the fixture and stays null on the wire.
    expect(out[1].kind).toBe("inline");
    if (out[1].kind === "inline") expect(out[1].line).toBeNull();
  });

  it("returns [] on exec error", async () => {
    stubExecThrow();
    expect(await getPrReviewComments("foo/bar", 1)).toEqual([]);
  });

  it("returns [] on malformed stdout", async () => {
    stubExecOk("{ not json");
    expect(await getPrReviewComments("foo/bar", 1)).toEqual([]);
  });

  it("uses the paginated api endpoint", async () => {
    stubExecOk("[]");
    await getPrReviewComments("foo/bar", 7);
    const call = handler.calls[0];
    expect(call[0]).toBe("gh");
    expect(call[1]).toEqual([
      "api",
      "/repos/foo/bar/pulls/7/comments",
      "--paginate",
    ]);
  });
});

describe("isPrClosed", () => {
  it("returns true for MERGED state", async () => {
    stubExecOk(JSON.stringify({ state: "MERGED" }));
    expect(await isPrClosed("foo/bar", 1)).toBe(true);
  });

  it("returns true for CLOSED state", async () => {
    stubExecOk(JSON.stringify({ state: "CLOSED" }));
    expect(await isPrClosed("foo/bar", 1)).toBe(true);
  });

  it("returns false for OPEN state", async () => {
    stubExecOk(JSON.stringify({ state: "OPEN" }));
    expect(await isPrClosed("foo/bar", 1)).toBe(false);
  });

  it("returns false on exec error", async () => {
    stubExecThrow();
    expect(await isPrClosed("foo/bar", 1)).toBe(false);
  });
});
