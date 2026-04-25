import { describe, it, expect } from "vitest";
import {
  impactAnalyzerSystemPrompt,
  impactAnalyzerInitialPrompt,
} from "@src/pipelines/pr-review/impact-prompts.js";

const REPO = "acme/widgets";
const ARTIFACTS = "/tmp/artifacts/task-123";
const WORKTREE = "/tmp/worktree/task-123";
const MEMORY = "=== MEMORY _root/architecture.md ===\nwe speak ESM only\n=== END _root/architecture.md ===";

const SECTION_HEADERS = [
  "## Summary",
  "## Touched Zones & Relevant Memory",
  "## Affected Symbols & Live Context",
  "## Risks",
  "## Memory Gaps & Blind Spots",
];

describe("impactAnalyzerSystemPrompt", () => {
  const prompt = impactAnalyzerSystemPrompt(REPO, ARTIFACTS, WORKTREE, MEMORY);

  it("contains every required section header", () => {
    for (const h of SECTION_HEADERS) expect(prompt).toContain(h);
  });

  it("embeds the memory body verbatim", () => {
    expect(prompt).toContain(MEMORY);
  });

  it("ends with the IMPACT_ANALYSIS_DONE sentinel", () => {
    expect(prompt).toContain("IMPACT_ANALYSIS_DONE");
  });

  it("instructs read-only behaviour on the worktree", () => {
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain(`You may NOT edit any file in ${WORKTREE}`);
  });

  it("references the artifacts dir for inputs and output", () => {
    expect(prompt).toContain(`${ARTIFACTS}/pr-context.json`);
    expect(prompt).toContain(`${ARTIFACTS}/pr.diff`);
    expect(prompt).toContain(`${ARTIFACTS}/pr-impact.md`);
  });

  it("falls back to a no-memory message when memory is empty", () => {
    const empty = impactAnalyzerSystemPrompt(REPO, ARTIFACTS, WORKTREE, "");
    expect(empty).toContain("NO MEMORY AVAILABLE");
    expect(empty).toContain(REPO);
  });

  it("treats whitespace-only memory as empty", () => {
    const ws = impactAnalyzerSystemPrompt(REPO, ARTIFACTS, WORKTREE, "   \n\n  ");
    expect(ws).toContain("NO MEMORY AVAILABLE");
  });
});

describe("impactAnalyzerInitialPrompt", () => {
  it("references pr-context.json, pr.diff, and pr-impact.md", () => {
    const p = impactAnalyzerInitialPrompt(ARTIFACTS);
    expect(p).toContain(`${ARTIFACTS}/pr-context.json`);
    expect(p).toContain(`${ARTIFACTS}/pr.diff`);
    expect(p).toContain(`${ARTIFACTS}/pr-impact.md`);
    expect(p).toContain("IMPACT_ANALYSIS_DONE");
  });
});
