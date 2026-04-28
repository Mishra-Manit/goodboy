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

  it("contains the auto-fix rule covering style, correctness minor/nit, and factual doc drift", () => {
    expect(prompt).toContain("category=style");
    expect(prompt).toContain("correctness severity in {minor, nit}");
    expect(prompt).toContain("stale docstrings, comments, CLI banners, help text, or docs");
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

  it("forces project-local codebase-explorer in one parallel subagent call", () => {
    expect(prompt).toContain("Use only the project-scoped 'codebase-explorer' agent");
    expect(prompt).toContain(`agent: "codebase-explorer"`);
    expect(prompt).toContain(`agentScope: "project"`);
    expect(prompt).toContain("Never use reviewer, worker, scout, builtin agents, user agents, or action: \"list\"");
    expect(prompt).toContain("Set concurrency to the total task count");
  });

  it("references both FILE-GROUP and HOLISTIC codebase-explorer task templates", () => {
    expect(prompt).toContain("FILE-GROUP codebase-explorer task");
    expect(prompt).toContain("HOLISTIC codebase-explorer task");
  });

  it("tells the analyst to calibrate severity conservatively", () => {
    expect(prompt).toContain("Calibrate severity conservatively");
    expect(prompt).toContain("Do not inflate severity for stale docs");
  });

  it("requires a short, readable markdown comment with color indicators", () => {
    expect(prompt).toContain("SHORT, clean GitHub markdown comment");
    expect(prompt).toContain("Conversational, calm, easy to scan");
    expect(prompt).toContain("🔴 blocker, 🟠 major, 🟡 minor, 🔵 nit");
    expect(prompt).toContain("## Needs author action");
    expect(prompt).toContain("## Follow-ups");
  });

  it("names pr-impact.md as the primary context", () => {
    expect(prompt).toContain("pr-impact.md");
    expect(prompt).toContain("primary");
  });

  it("documents the context-hiding and JSON report contracts for subagents", () => {
    expect(prompt).toContain("Subagents do NOT receive pr-impact.md or the full memory block");
    expect(prompt).toContain("Return ONLY valid JSON matching the schema below");
    expect(prompt).toContain("Never continue with a\n   missing report");
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
