import { describe, it, expect } from "vitest";
import path from "node:path";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  taskSessionPath,
  prSessionPath,
  readSessionFile,
} from "@src/core/pi/session-file.js";

describe("path helpers", () => {
  it("taskSessionPath composes artifactsDir/taskId/<stage>.session.jsonl", () => {
    const p = taskSessionPath("abc-123", "planner");
    expect(p.endsWith(path.join("abc-123", "planner.session.jsonl"))).toBe(true);
    expect(path.isAbsolute(p)).toBe(true);
  });

  it("taskSessionPath includes optional stage variant", () => {
    const p = taskSessionPath("abc-123", "pr_impact", 2);
    expect(p.endsWith(path.join("abc-123", "pr_impact.v2.session.jsonl"))).toBe(true);
  });
  it("prSessionPath composes prSessionsDir/<id>.jsonl", () => {
    const p = prSessionPath("xyz");
    expect(p.endsWith(path.join("xyz.jsonl"))).toBe(true);
    expect(path.isAbsolute(p)).toBe(true);
  });
});

describe("readSessionFile", () => {
  it("returns [] when file is missing", async () => {
    const entries = await readSessionFile("/tmp/goodboy-does-not-exist.jsonl");
    expect(entries).toEqual([]);
  });

  it("parses valid JSONL and skips malformed lines", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(
      file,
      [
        JSON.stringify({ type: "session", id: "s1", version: 3, timestamp: "t", cwd: "/" }),
        "{ not json",
        JSON.stringify({
          type: "message",
          id: "m1",
          parentId: null,
          timestamp: "t",
          message: { role: "user", content: [], timestamp: 0 },
        }),
        "",
      ].join("\n"),
    );
    const entries = await readSessionFile(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("session");
    expect(entries[1].type).toBe("message");
  });

  it("throws when session version exceeds CURRENT_SESSION_VERSION", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session", id: "s", version: 999, timestamp: "t", cwd: "/" }),
    );
    await expect(readSessionFile(file)).rejects.toThrow(/Unsupported pi session version/);
  });

  it("accepts files without a version field (pre-v3)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(
      file,
      JSON.stringify({ type: "session", id: "s", timestamp: "t", cwd: "/" }),
    );
    const entries = await readSessionFile(file);
    expect(entries).toHaveLength(1);
  });

  it("returns empty for an empty file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, "");
    const entries = await readSessionFile(file);
    expect(entries).toEqual([]);
  });
});
