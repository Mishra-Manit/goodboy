import { describe, it, expect } from "vitest";
import {
  prAnalystSystemPrompt,
  prAnalystInitialPrompt,
} from "@src/pipelines/pr-review/analyst-prompts.js";

const OPTS = {
  repo: "acme/widgets",
  nwo: "acme/widgets",
  headRef: "feature/cool",
  prNumber: 42,
  artifactsDir: "/tmp/artifacts/task-123",
  worktreePath: "/tmp/worktree/task-123",
} as const;

describe("prAnalystSystemPrompt", () => {
  const prompt = prAnalystSystemPrompt(OPTS);

  it("contains the auto-fix rule covering style and correctness minor/nit", () => {
    expect(prompt).toContain("category=style");
    expect(prompt).toContain("correctness severity in {minor, nit}");
  });

  it("embeds the concrete gh pr comment command", () => {
    expect(prompt).toContain("gh pr comment 42 --repo acme/widgets");
    expect(prompt).toContain("--body-file /tmp/artifacts/task-123/summary.md");
  });

  it("tells the analyst to git push origin <headRef>", () => {
    expect(prompt).toContain("git push origin feature/cool");
  });

  it("forbids gh pr review (no approvals or request-changes in v1)", () => {
    expect(prompt).toContain("Do NOT run gh pr review");
  });

  it("references both FILE-GROUP and HOLISTIC subagent templates", () => {
    expect(prompt).toContain("FILE-GROUP subagent");
    expect(prompt).toContain("HOLISTIC subagent");
  });

  it("names pr-impact.md as the primary context", () => {
    expect(prompt).toContain("pr-impact.md");
    expect(prompt).toContain("primary");
  });

  it("documents the context-hiding contract for subagents", () => {
    expect(prompt).toContain("Subagents do NOT receive pr-impact.md or the full memory block");
  });

  it("requires the {\"status\": \"complete\"} end sentinel", () => {
    expect(prompt).toContain(`{"status": "complete"}`);
  });

  it("references the artifacts + worktree paths", () => {
    expect(prompt).toContain(`${OPTS.artifactsDir}/pr-context.json`);
    expect(prompt).toContain(`${OPTS.artifactsDir}/pr.diff`);
    expect(prompt).toContain(`${OPTS.artifactsDir}/review-plan.json`);
    expect(prompt).toContain(`${OPTS.artifactsDir}/reports/`);
    expect(prompt).toContain(OPTS.worktreePath);
  });
});

describe("prAnalystInitialPrompt", () => {
  it("references pr-impact.md and the end sentinel", () => {
    const p = prAnalystInitialPrompt(OPTS.artifactsDir);
    expect(p).toContain(`${OPTS.artifactsDir}/pr-impact.md`);
    expect(p).toContain(`${OPTS.artifactsDir}/pr-context.json`);
    expect(p).toContain(`${OPTS.artifactsDir}/pr.diff`);
    expect(p).toContain(`{"status": "complete"}`);
  });
});
