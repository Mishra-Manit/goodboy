import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readReviewArtifact } from "@src/pipelines/pr-review/artifacts/read-review.js";
import type { PrReviewArtifact } from "@src/shared/contracts/pr-review.js";

const validArtifact: PrReviewArtifact = {
  prTitle: "Add review page",
  headSha: "abc123456789",
  summary: "This review explains the PR.",
  chapters: [
    {
      id: "main-change",
      title: "Main change",
      files: ["src/a.ts"],
      rationale: "This file carries the core behavior.",
      annotations: [],
    },
  ],
  orderedChapterIds: ["main-change"],
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "goodboy-review-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readReviewArtifact", () => {
  it("returns null for a missing file", async () => {
    await expect(readReviewArtifact(path.join(dir, "missing.json"))).resolves.toBeNull();
  });

  it("returns null for malformed JSON", async () => {
    const file = path.join(dir, "review.json");
    await writeFile(file, "{nope", "utf8");

    await expect(readReviewArtifact(file)).resolves.toBeNull();
  });

  it("returns null for schema-invalid JSON", async () => {
    const file = path.join(dir, "review.json");
    await writeFile(file, JSON.stringify({ prTitle: "Missing fields" }), "utf8");

    await expect(readReviewArtifact(file)).resolves.toBeNull();
  });

  it("returns the parsed artifact and mtime for valid JSON", async () => {
    const file = path.join(dir, "review.json");
    await writeFile(file, JSON.stringify(validArtifact), "utf8");

    const result = await readReviewArtifact(file);

    expect(result?.artifact).toEqual(validArtifact);
    expect(result?.createdAt).toBeInstanceOf(Date);
  });
});
