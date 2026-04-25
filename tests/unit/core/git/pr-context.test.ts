import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

// Same execFile mocking pattern used in github.io.test.ts. See that file
// for the full explanation of why the promisify.custom symbol is needed.
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
  const { promisify } = require("node:util") as typeof import("node:util");
  const execFile = (cmd: string, args: readonly string[]) => handler.invoke(cmd, args);
  (execFile as unknown as { [k: symbol]: unknown })[promisify.custom] = execFile;
  return { execFile };
});

import { getPrMetadata, getPrDiff } from "@src/core/git/github.js";

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

describe("getPrMetadata", () => {
  it("maps gh pr view --json output to PrMetadata", async () => {
    stubExecOk(await readFile("tests/fixtures/gh/pr-view-metadata.json", "utf-8"));
    const meta = await getPrMetadata("foo/bar", 42);

    expect(meta.number).toBe(42);
    expect(meta.title).toBe("Add feature X");
    expect(meta.body).toBe("This PR adds X.");
    expect(meta.labels).toEqual(["enhancement", "backend"]);
    expect(meta.author).toBe("alice");
    expect(meta.baseRef).toBe("main");
    expect(meta.headRef).toBe("feature/x");
    expect(meta.changedFiles).toEqual([
      { path: "src/a.ts", additions: 10, deletions: 2 },
      { path: "src/a.test.ts", additions: 20, deletions: 0 },
    ]);
  });

  it("falls back to empty string when body is null", async () => {
    stubExecOk(JSON.stringify({
      number: 1, title: "t", body: null,
      labels: [], author: { login: "x" },
      baseRefName: "main", headRefName: "f", files: [],
    }));
    const meta = await getPrMetadata("o/r", 1);
    expect(meta.body).toBe("");
  });

  it("throws when gh exits non-zero", async () => {
    stubExecThrow();
    await expect(getPrMetadata("foo/bar", 42)).rejects.toThrow(/gh blew up/);
  });

  it("invokes gh with the expected arguments", async () => {
    stubExecOk(await readFile("tests/fixtures/gh/pr-view-metadata.json", "utf-8"));
    await getPrMetadata("foo/bar", 42);

    expect(handler.calls).toHaveLength(1);
    const [cmd, args] = handler.calls[0]!;
    expect(cmd).toBe("gh");
    expect(args).toEqual([
      "pr", "view", "42",
      "--repo", "foo/bar",
      "--json", "number,title,body,labels,author,baseRefName,headRefName,files",
    ]);
  });
});

describe("getPrDiff", () => {
  it("returns raw stdout", async () => {
    stubExecOk("diff --git a/x b/x\n@@ -0,0 +1 @@\n+hi\n");
    const diff = await getPrDiff("foo/bar", 42);
    expect(diff).toContain("diff --git");
    expect(diff).toContain("+hi");
  });

  it("invokes gh pr diff with --repo", async () => {
    stubExecOk("");
    await getPrDiff("foo/bar", 42);
    const [cmd, args] = handler.calls[0]!;
    expect(cmd).toBe("gh");
    expect(args).toEqual(["pr", "diff", "42", "--repo", "foo/bar"]);
  });

  it("throws when gh exits non-zero", async () => {
    stubExecThrow();
    await expect(getPrDiff("foo/bar", 42)).rejects.toThrow();
  });
});
