import { describe, expect, it } from "vitest";

import { buildClassifierSystemPrompt } from "@src/telegram/prompts.js";

describe("buildClassifierSystemPrompt", () => {
  it("teaches the model to map review-language + PR URL messages to pr_review", () => {
    const prompt = buildClassifierSystemPrompt([
      { name: "goodboy", githubUrl: "https://github.com/acme/goodboy" },
      { name: "coliseum", githubUrl: "https://github.com/acme/coliseum" },
    ]);

    expect(prompt).toContain("review this PR");
    expect(prompt).toContain("GitHub: https://github.com/acme/goodboy");
    expect(prompt).toContain("If the message includes a GitHub pull-request URL and the user is clearly asking for review");
    expect(prompt).toContain("if a GitHub PR URL is present and it matches one of the available repos, use that repo");
    expect(prompt).toContain("please review https://github.com/me/goodboy/pull/77 for me");
  });
});
