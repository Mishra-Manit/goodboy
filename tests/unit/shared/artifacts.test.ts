import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { artifactPath, hasNonEmptyArtifact, requireNonEmptyArtifact } from "@src/shared/artifacts.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map(async (dir) => {
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  }));
  tempDirs.length = 0;
});

describe("artifact helpers", () => {
  it("builds artifact paths inside the given artifacts dir", () => {
    expect(artifactPath("/tmp/task-1", "plan.md")).toBe(path.join("/tmp/task-1", "plan.md"));
  });

  it("detects whether an artifact exists and is non-empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "goodboy-artifacts-"));
    tempDirs.push(dir);
    await mkdir(dir, { recursive: true });

    expect(await hasNonEmptyArtifact(dir, "plan.md")).toBe(false);

    await writeFile(path.join(dir, "plan.md"), "hello");
    expect(await hasNonEmptyArtifact(dir, "plan.md")).toBe(true);
  });

  it("throws a descriptive error when a required artifact is missing or empty", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "goodboy-artifacts-"));
    tempDirs.push(dir);

    await expect(requireNonEmptyArtifact(dir, "plan.md", "missing plan")).rejects.toThrow(/missing plan/);

    await writeFile(path.join(dir, "plan.md"), "");
    await expect(requireNonEmptyArtifact(dir, "plan.md", "missing plan")).rejects.toThrow(/file is empty/);
  });
});
