import { describe, it, expect } from "vitest";
import {
  impactAnalyzerSystemPrompt,
  impactAnalyzerInitialPrompt,
} from "@src/pipelines/pr-review/prompts/impact.js";

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
  const prompt = impactAnalyzerSystemPrompt(REPO, ARTIFACTS, WORKTREE, MEMORY, "", 2);

  it("contains every required section header", () => {
    for (const h of SECTION_HEADERS) expect(prompt).toContain(h);
  });

  it("embeds the memory body verbatim", () => {
    expect(prompt).toContain(MEMORY);
  });

  it("ends with the IMPACT_ANALYSIS_DONE sentinel", () => {
    expect(prompt).toContain("IMPACT_ANALYSIS_DONE");
  });

  it("scopes read-only behaviour to the worktree", () => {
    expect(prompt).toContain(`read-only on the worktree at ${WORKTREE}`);
    expect(prompt).toContain("Your single write target");
  });

  it("references the artifacts dir for inputs and output", () => {
    expect(prompt).toContain(`${ARTIFACTS}/pr-context.json`);
    expect(prompt).toContain(`${ARTIFACTS}/pr.diff.v2`);
    expect(prompt).toContain(`${ARTIFACTS}/pr-impact.v2.md`);
    expect(prompt).toContain("Hard cap: 120 lines in");
  });

  it("falls back to a no-memory message when memory is empty", () => {
    const empty = impactAnalyzerSystemPrompt(REPO, ARTIFACTS, WORKTREE, "", "", 1);
    expect(empty).toContain("NO MEMORY AVAILABLE");
    expect(empty).toContain(REPO);
  });

  it("treats whitespace-only memory as empty", () => {
    const ws = impactAnalyzerSystemPrompt(REPO, ARTIFACTS, WORKTREE, "   \n\n  ", "", 1);
    expect(ws).toContain("NO MEMORY AVAILABLE");
  });
});

describe("impactAnalyzerInitialPrompt", () => {
  it("references pr-context.json and variant diff/impact files", () => {
    const p = impactAnalyzerInitialPrompt(ARTIFACTS, 3);
    expect(p).toContain(`${ARTIFACTS}/pr-context.json`);
    expect(p).toContain(`${ARTIFACTS}/pr.diff.v3`);
    expect(p).toContain(`${ARTIFACTS}/pr-impact.v3.md`);
    expect(p).toContain("IMPACT_ANALYSIS_DONE");
  });
});
