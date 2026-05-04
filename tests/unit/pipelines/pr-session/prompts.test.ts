import { describe, expect, it } from "vitest";
import { formatCommentsPrompt, prSessionPrompt } from "@src/pipelines/pr-session/prompts.js";

describe("prSessionPrompt", () => {
  it("requires PR creation turns to return a structured PR URL final response", () => {
    const prompt = prSessionPrompt({
      mode: "own",
      repo: "pantheon",
      githubRepo: "Mishra-Manit/pantheon",
      branch: "goodboy/add-feature-12345678",
      planPath: "/tmp/plan.md",
      summaryPath: "/tmp/summary.md",
      reviewPath: "/tmp/review.md",
    });

    expect(prompt).toContain("GITHUB_REPO: Mishra-Manit/pantheon");
    expect(prompt).toContain("gh pr create");
    expect(prompt).toContain("--repo Mishra-Manit/pantheon");
    expect(prompt).not.toContain("--repo pantheon");
    expect(prompt).toContain("Contract: pr_session.creation");
    expect(prompt).toContain('"prUrl"');
    expect(prompt).toContain("https://github.com/OWNER/REPO/pull/123");
  });

  it("uses the default completion contract for owned PR resume turns", () => {
    const prompt = prSessionPrompt({
      mode: "own",
      repo: "pantheon",
      githubRepo: "Mishra-Manit/pantheon",
      branch: "goodboy/add-feature-12345678",
      prNumber: 12,
    });

    expect(prompt).not.toContain("NO PR EXISTS YET");
    expect(prompt).toContain("Contract: stage.complete");
    expect(prompt).toContain('{"status":"complete"}');
    expect(prompt).not.toContain('"prUrl"');
  });

  it("uses owner/repo in review-mode gh commands", () => {
    const prompt = prSessionPrompt({
      mode: "review",
      repo: "pantheon",
      githubRepo: "Mishra-Manit/pantheon",
      branch: "feature/x",
      prNumber: 12,
    });

    expect(prompt).toContain("gh pr diff 12 --repo Mishra-Manit/pantheon");
    expect(prompt).toContain("gh pr review 12 --repo Mishra-Manit/pantheon");
    expect(prompt).not.toContain("--repo pantheon");
  });
});

describe("formatCommentsPrompt", () => {
  it("renders the default final response contract for comment turns", () => {
    const prompt = formatCommentsPrompt([
      {
        kind: "conversation",
        id: "1",
        author: "human",
        body: "please fix this",
        createdAt: "2026-05-04T00:00:00.000Z",
      },
    ]);

    expect(prompt).toContain("FINAL RESPONSE CONTRACT -- HARD REQUIREMENT");
    expect(prompt).toContain("Contract: stage.complete");
    expect(prompt).toContain('{"status":"complete"}');
  });
});
