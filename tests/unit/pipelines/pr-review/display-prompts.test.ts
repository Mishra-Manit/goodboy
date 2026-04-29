import { describe, expect, it } from "vitest";
import {
  prDisplayInitialPrompt,
  prDisplaySystemPrompt,
} from "@src/pipelines/pr-review/display-prompts.js";

const opts = {
  repo: "goodboy",
  nwo: "acme/goodboy",
  prNumber: 42,
  artifactsDir: "/tmp/artifacts/task-1",
  worktreePath: "/tmp/worktree",
};

describe("prDisplaySystemPrompt", () => {
  it("includes all artifact paths and write-boundary instructions", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("/tmp/artifacts/task-1/pr-context.updated.json");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr.updated.diff");
    expect(prompt).toContain("/tmp/artifacts/task-1/reports/*.json");
    expect(prompt).toContain("/tmp/artifacts/task-1/review.json");
    expect(prompt).toContain("Artifacts dir: /tmp/artifacts/task-1 (writable");
    expect(prompt).toContain("outside the worktree");
  });

  it("documents schema constraints that commonly break model output", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("starts with [a-z0-9]");
    expect(prompt).toContain("never 0");
    expect(prompt).toContain("orderedChapterIds last");
    expect(prompt).toContain("filePath appears in that chapter's files[]");
  });

  it("keeps annotations diff-scoped and handles optional impact context", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("every annotation must reference a line in the");
    expect(prompt).toContain("Do not annotate unrelated files");
    expect(prompt).toContain("may be absent if impact failed");
  });
});

describe("prDisplayInitialPrompt", () => {
  it("treats the impact report as optional", () => {
    const prompt = prDisplayInitialPrompt(opts.artifactsDir);

    expect(prompt).toContain("Also read /tmp/artifacts/task-1/pr-impact.md if it exists");
  });
});
