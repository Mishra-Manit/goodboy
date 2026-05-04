import { describe, expect, it } from "vitest";
import {
  prDisplayInitialPrompt,
  prDisplaySystemPrompt,
} from "@src/pipelines/pr-review/prompts/display.js";

const opts = {
  repo: "goodboy",
  nwo: "acme/goodboy",
  prNumber: 42,
  artifactsDir: "/tmp/artifacts/task-1",
  worktreePath: "/tmp/worktree",
  availableImpactVariants: [1, 3],
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
    expect(prompt).toContain("Minimal valid shape to copy before filling details");
    expect(prompt).toContain('"prTitle": "PR title from pr-context.updated.json"');
    expect(prompt).toContain('"chapters": [');
  });

  it("keeps annotations diff-scoped and handles optional impact context", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("every annotation must reference a line in the");
    expect(prompt).toContain("Do not annotate unrelated files");
    expect(prompt).toContain("Successful impact analyzer curated context variants");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr-impact.v1.md");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr-impact.v3.md");
    expect(prompt).not.toContain("/tmp/artifacts/task-1/pr-impact.v2.md");
  });

  it("forces concise dashboard copy for annotations", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("small UI");
    expect(prompt).toContain("Title: <= 70 chars");
    expect(prompt).toContain("Body: <= 220 chars");
    expect(prompt).toContain("Prefer 3-8 total annotations");
    expect(prompt).toContain("summarize its point in your own short UI copy");
  });

  it("makes the required dashboard top-level keys explicit", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("top-level keys must be exactly");
    expect(prompt).toContain("prTitle, headSha, summary, chapters, orderedChapterIds");
    expect(prompt).toContain("Every chapter object must include id, title, files, rationale, annotations");
    expect(prompt).toContain("Every annotation object must include filePath, side, line, kind, title, body");
    expect(prompt).toContain('Annotation side values must be exactly "old" or "new"');
    expect(prompt).toContain('Annotation kind values must be exactly "user_change", "goodboy_fix", "concern", or "note"');
  });

  it("documents how to convert subagent report issues into dashboard annotations", () => {
    const prompt = prDisplaySystemPrompt(opts);

    expect(prompt).toContain("Report issue conversion");
    expect(prompt).toContain("report issue 'file' becomes annotation 'filePath'");
    expect(prompt).toContain("report issue 'line_start' becomes annotation 'line'");
    expect(prompt).toContain("report issue 'category' and 'severity' are ranking inputs only");
    expect(prompt).toContain("GitHub/diff side 'right' maps to 'new'");
    expect(prompt).toContain("Allowed dashboard enum values to copy exactly");
    expect(prompt).toContain("Chapter construction from selected annotations");
    expect(prompt).toContain("unique annotation 'filePath' values");
  });
});

describe("prDisplayInitialPrompt", () => {
  it("treats the impact report as optional", () => {
    const prompt = prDisplayInitialPrompt(opts.artifactsDir, [1, 3]);

    expect(prompt).toContain("Also read successful impact variant files");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr-impact.v3.md");
    expect(prompt).toContain("annotation bodies <=220 chars");
    expect(prompt).toContain("Required top-level keys: prTitle, headSha, summary, chapters, orderedChapterIds");
    expect(prompt).toContain("Required chapter keys: id, title, files, rationale, annotations");
    expect(prompt).toContain("Required annotation keys: filePath, side, line, kind, title, body");
    expect(prompt).toContain("Convert report file→filePath and line_start→line");
    expect(prompt).toContain('Use side exactly "new" or "old"');
    expect(prompt).toContain('Use kind exactly "concern" for unresolved report issues');
    expect(prompt).toContain("Report categories like correctness/tests/security/style are ranking inputs only");
    expect(prompt).not.toContain("/tmp/artifacts/task-1/pr-impact.v2.md");
  });
});
