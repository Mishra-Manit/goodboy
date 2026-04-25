import { describe, it, expect } from "vitest";
import {
  prReviewIssueSchema,
  prReviewReportSchema,
  prReviewPlanSchema,
} from "@src/shared/types.js";

const validIssue = {
  file: "src/a.ts",
  line_start: 10,
  line_end: 12,
  severity: "minor",
  category: "style",
  title: "prefer const",
  rationale: "let is not reassigned",
  suggested_fix: "replace let with const",
};

describe("prReviewIssueSchema", () => {
  it("accepts a well-formed issue", () => {
    expect(prReviewIssueSchema.parse(validIssue)).toEqual(validIssue);
  });

  it("rejects unknown severity", () => {
    expect(() => prReviewIssueSchema.parse({ ...validIssue, severity: "fatal" })).toThrow();
  });

  it("rejects unknown category", () => {
    expect(() => prReviewIssueSchema.parse({ ...validIssue, category: "performance" })).toThrow();
  });

  it("rejects negative line numbers", () => {
    expect(() => prReviewIssueSchema.parse({ ...validIssue, line_start: -1 })).toThrow();
  });

  it("rejects missing line_start", () => {
    const { line_start, ...rest } = validIssue;
    void line_start;
    expect(() => prReviewIssueSchema.parse(rest)).toThrow();
  });

  it("rejects empty title/rationale/suggested_fix", () => {
    expect(() => prReviewIssueSchema.parse({ ...validIssue, title: "" })).toThrow();
    expect(() => prReviewIssueSchema.parse({ ...validIssue, rationale: "" })).toThrow();
    expect(() => prReviewIssueSchema.parse({ ...validIssue, suggested_fix: "" })).toThrow();
  });
});

describe("prReviewReportSchema", () => {
  const base = {
    subagent_id: "group-01",
    files_reviewed: ["src/a.ts"],
    dimensions: ["correctness", "style"],
    issues: [validIssue],
  };

  it("accepts a well-formed report and defaults notes to empty", () => {
    const parsed = prReviewReportSchema.parse(base);
    expect(parsed.notes).toBe("");
  });

  it("rejects empty dimensions", () => {
    expect(() => prReviewReportSchema.parse({ ...base, dimensions: [] })).toThrow();
  });

  it("rejects unknown dimension value", () => {
    expect(() => prReviewReportSchema.parse({ ...base, dimensions: ["perf"] })).toThrow();
  });

  it("accepts an empty issues array", () => {
    expect(() => prReviewReportSchema.parse({ ...base, issues: [] })).not.toThrow();
  });
});

describe("prReviewPlanSchema", () => {
  const base = {
    groups: [
      { id: "group-01", files: ["src/a.ts"], dimensions: ["correctness"], focus: "validate input handling" },
    ],
    skipped: ["package-lock.json"],
    focus_notes: "adds feature X",
  };

  it("accepts a well-formed plan", () => {
    expect(prReviewPlanSchema.parse(base)).toEqual(base);
  });

  it("defaults focus to empty string when omitted", () => {
    const { focus, ...g0 } = base.groups[0]!;
    void focus;
    const parsed = prReviewPlanSchema.parse({ ...base, groups: [g0] });
    expect(parsed.groups[0]!.focus).toBe("");
  });

  it("rejects an empty files array in a group", () => {
    expect(() =>
      prReviewPlanSchema.parse({
        ...base,
        groups: [{ id: "group-01", files: [], dimensions: ["correctness"], focus: "" }],
      }),
    ).toThrow();
  });

  it("rejects an empty groups array", () => {
    expect(() => prReviewPlanSchema.parse({ ...base, groups: [] })).toThrow();
  });
});
