import { describe, it, expect } from "vitest";
import {
  prAnalystSystemPrompt,
  prAnalystInitialPrompt,
} from "@src/pipelines/pr-review/prompts/analyst.js";

const OPTS = {
  repo: "acme/widgets",
  nwo: "acme/widgets",
  headRef: "feature/cool",
  prNumber: 42,
  artifactsDir: "/tmp/artifacts/task-123",
  worktreePath: "/tmp/worktree/task-123",
  availableImpactVariants: [1, 3],
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

  it("forces project-local pr-slice-reviewer in one compact parallel subagent call", () => {
    expect(prompt).toContain("Use only the project-scoped 'pr-slice-reviewer' agent");
    expect(prompt).toContain(`"agent": "pr-slice-reviewer"`);
    expect(prompt).toContain(`agentScope: "project"`);
    expect(prompt).toContain("Never use codebase-explorer, reviewer, worker, scout, builtin agents, or user agents");
    expect(prompt).toContain("Do not call\n   subagent with action: \"list\"");
    expect(prompt).toContain("Set concurrency to the total task count");
    expect(prompt).toContain("Each task string must be one sentence");
  });

  it("keeps subagent prompts short and delegates schema details to the agent", () => {
    expect(prompt).toContain("subagent_id=group-01; artifacts=/tmp/artifacts/task-123; review this group from review-plan.json.");
    expect(prompt).toContain("subagent_id=holistic; artifacts=/tmp/artifacts/task-123; review cross-cutting PR risks.");
    expect(prompt).toContain("The pr-slice-reviewer agent reads review-plan.json, pr.diff, and");
    expect(prompt).toContain("It owns the JSON schema and changed-line filtering");
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

  it("names successful impact variants as primary context", () => {
    expect(prompt).toContain("pr-impact.v1.md");
    expect(prompt).toContain("pr-impact.v3.md");
    expect(prompt).toContain("primary");
    expect(prompt).toContain("Dedupe");
    expect(prompt).toContain("higher-confidence");
  });

  it("documents the context-hiding and JSON report contracts for subagents", () => {
    expect(prompt).toContain("Subagents do NOT receive pr-impact.vN.md files or the full memory block");
    expect(prompt).toContain("It owns the JSON schema and changed-line filtering");
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
  it("references impact variants and the end sentinel", () => {
    const p = prAnalystInitialPrompt(OPTS.artifactsDir, [1, 3]);
    expect(p).toContain(`${OPTS.artifactsDir}/pr-impact.v1.md`);
    expect(p).toContain(`${OPTS.artifactsDir}/pr-impact.v3.md`);
    expect(p).toContain(`${OPTS.artifactsDir}/pr-context.json`);
    expect(p).toContain(`${OPTS.artifactsDir}/pr.diff`);
    expect(p).toContain(`{"status": "complete"}`);
  });

  it("omits missing variant filenames when falling back to memory", () => {
    const p = prAnalystInitialPrompt(OPTS.artifactsDir, []);
    expect(p).toContain("full memory fallback");
    expect(p).not.toContain("pr-impact.v1.md");
  });
});
