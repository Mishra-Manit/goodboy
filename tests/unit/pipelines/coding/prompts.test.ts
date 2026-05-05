import { describe, expect, it } from "vitest";
import { prCreatorPrompts } from "@src/pipelines/coding/prompts.js";

describe("prCreatorPrompts", () => {
  it("targets the correct github repo in gh commands", () => {
    const { systemPrompt } = prCreatorPrompts({
      branch: "goodboy/add-feature-12345678",
      githubRepo: "Mishra-Manit/pantheon",
      repo: "pantheon",
      artifactsDir: "/tmp/artifacts",
    });

    expect(systemPrompt).toContain("GITHUB_REPO: Mishra-Manit/pantheon");
    expect(systemPrompt).toContain("--repo Mishra-Manit/pantheon");
    expect(systemPrompt).not.toContain("--repo pantheon");
  });

  it("includes the prCreationFinalResponseContract in the prompt", () => {
    const { systemPrompt } = prCreatorPrompts({
      branch: "goodboy/test-branch",
      githubRepo: "Mishra-Manit/pantheon",
      repo: "pantheon",
      artifactsDir: "/tmp/artifacts",
    });

    expect(systemPrompt).toContain("Contract: pr_session.creation");
    expect(systemPrompt).toContain('"prUrl"');
    expect(systemPrompt).toContain("https://github.com/OWNER/REPO/pull/123");
  });

  it("embeds artifact paths derived from artifactsDir", () => {
    const { systemPrompt } = prCreatorPrompts({
      branch: "goodboy/test-branch",
      githubRepo: "Mishra-Manit/pantheon",
      repo: "pantheon",
      artifactsDir: "/tmp/task-abc/artifacts",
    });

    expect(systemPrompt).toContain("/tmp/task-abc/artifacts/plan.md");
    expect(systemPrompt).toContain("/tmp/task-abc/artifacts/implementation-summary.md");
    expect(systemPrompt).toContain("/tmp/task-abc/artifacts/review.md");
  });

  it("initial prompt references artifactsDir", () => {
    const { initialPrompt } = prCreatorPrompts({
      branch: "goodboy/test-branch",
      githubRepo: "Mishra-Manit/pantheon",
      repo: "pantheon",
      artifactsDir: "/tmp/task-abc/artifacts",
    });

    expect(initialPrompt).toContain("/tmp/task-abc/artifacts");
  });

  it("warns against backtick usage in body string", () => {
    const { systemPrompt } = prCreatorPrompts({
      branch: "goodboy/test-branch",
      githubRepo: "Mishra-Manit/pantheon",
      repo: "pantheon",
      artifactsDir: "/tmp/artifacts",
    });

    expect(systemPrompt).toContain("--body-file");
    expect(systemPrompt).toContain("backtick");
  });
});
