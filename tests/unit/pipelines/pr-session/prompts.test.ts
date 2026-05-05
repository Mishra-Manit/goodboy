import { describe, expect, it } from "vitest";
import { formatCommentsPrompt, prSessionPrompt } from "@src/pipelines/pr-session/prompts.js";

describe("prSessionPrompt", () => {
  it("uses the default completion contract for owned PR resume turns", () => {
    const prompt = prSessionPrompt({
      mode: "own",
      repo: "pantheon",
      branch: "goodboy/add-feature-12345678",
      prNumber: 12,
    });

    expect(prompt).toContain("Contract: stage.complete");
    expect(prompt).toContain('{"status":"complete"}');
    expect(prompt).not.toContain('"prUrl"');
    expect(prompt).not.toContain("NO PR EXISTS YET");
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
