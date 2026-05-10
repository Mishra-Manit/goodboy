import { describe, expect, it } from "vitest";
import {
  prFinalizerInitialPrompt,
  prFinalizerSystemPrompt,
} from "@src/pipelines/pr-review/prompts/finalizer.js";

const opts = {
  repo: "goodboy",
  nwo: "acme/goodboy",
  prNumber: 42,
  taskId: "task-1",
  artifactsDir: "/tmp/artifacts/task-1",
  worktreePath: "/tmp/worktree",
  assetsDir: "/tmp/artifacts/task-1/assets",
  visualUrl: "https://goodboy.test/review-assets/task-1/pr-visual-summary.png",
  availableImpactVariants: [1, 3],
};

describe("prFinalizerSystemPrompt", () => {
  it("includes all artifact paths and write-boundary instructions", () => {
    const prompt = prFinalizerSystemPrompt(opts);

    expect(prompt).toContain("/tmp/artifacts/task-1/pr-context.updated.json");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr.updated.diff");
    expect(prompt).toContain("/tmp/artifacts/task-1/reports/*.json");
    expect(prompt).toContain("/tmp/artifacts/task-1/review.json");
    expect(prompt).toContain("Artifacts dir: /tmp/artifacts/task-1");
    expect(prompt).toContain("Assets dir: /tmp/artifacts/task-1/assets");
  });

  it("documents schema constraints that commonly break model output", () => {
    const prompt = prFinalizerSystemPrompt(opts);

    expect(prompt).toContain("visualSnapshot");
    expect(prompt).toContain("Minimal valid shape to copy before filling details");
    expect(prompt).toContain("pr-visual-summary.png");
    expect(prompt).toContain("filePath appears in that chapter's files[].path");
    expect(prompt).toContain('"prTitle": "PR title from pr-context.updated.json"');
    expect(prompt).toContain('"visualSnapshot": { "type": "skipped", "reason": "no_frontend_changes" }');
  });

  it("keeps annotations diff-scoped and handles optional impact context", () => {
    const prompt = prFinalizerSystemPrompt(opts);

    expect(prompt).toContain("Every annotation must reference a changed/context line");
    expect(prompt).toContain("Do not annotate unrelated files");
    expect(prompt).toContain("Successful impact analyzer curated context variants");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr-impact.v1.md");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr-impact.v3.md");
    expect(prompt).not.toContain("/tmp/artifacts/task-1/pr-impact.v2.md");
  });

  it("forces concise dashboard copy for annotations", () => {
    const prompt = prFinalizerSystemPrompt(opts);

    expect(prompt).toContain("Prefer 3-8 high-impact annotations");
    expect(prompt).toContain("Do not invent findings");
    expect(prompt).toContain("Never omit blockers/majors");
    expect(prompt).toContain("low-signal nits");
  });

  it("makes the required dashboard keys explicit", () => {
    const prompt = prFinalizerSystemPrompt(opts);

    expect(prompt).toContain("top-level keys must be exactly");
    expect(prompt).toContain("prTitle, headSha, summary, visualSnapshot, chapters");
    expect(prompt).toContain("Every chapter object must include id, title, narrative, files, annotations");
    expect(prompt).toContain("Every file object must include path and narrative");
    expect(prompt).toContain("Every annotation object must include filePath, line, kind, title, body");
    expect(prompt).toContain('Annotation kind values must be exactly "goodboy_fix", "concern", or "note"');
    expect(prompt).not.toContain("orderedChapterIds");
    expect(prompt).not.toContain("user_change");
  });

  it("documents how to convert subagent report issues into dashboard annotations", () => {
    const prompt = prFinalizerSystemPrompt(opts);

    expect(prompt).toContain("Report issue conversion");
    expect(prompt).toContain("report issue 'file' becomes annotation 'filePath'");
    expect(prompt).toContain("report issue 'line_start' becomes annotation 'line'");
    expect(prompt).toContain("report issue 'category' and 'severity' are ranking inputs only");
    expect(prompt).toContain("Allowed dashboard enum values to copy exactly");
    expect(prompt).toContain("Chapter construction from selected annotations");
    expect(prompt).toContain("files[].path");
  });
});

describe("prFinalizerInitialPrompt", () => {
  it("treats the impact report as optional", () => {
    const prompt = prFinalizerInitialPrompt(opts.artifactsDir, [1, 3]);

    expect(prompt).toContain("Also read successful impact variant files");
    expect(prompt).toContain("/tmp/artifacts/task-1/pr-impact.v3.md");
    expect(prompt).toContain("pr-visual-recorder");
    expect(prompt).toContain("Required top-level keys: prTitle, headSha, summary, visualSnapshot, chapters");
    expect(prompt).toContain("Required chapter keys: id, title, narrative, files, annotations");
    expect(prompt).toContain("Required file keys: path, narrative");
    expect(prompt).toContain("Required annotation keys: filePath, line, kind, title, body");
    expect(prompt).toContain("Convert report file→filePath and line_start→line");
    expect(prompt).toContain('Use kind exactly "concern" for unresolved report issues');
    expect(prompt).toContain("Report categories like correctness/tests/security/style are ranking inputs only");
    expect(prompt).not.toContain("/tmp/artifacts/task-1/pr-impact.v2.md");
  });
});
