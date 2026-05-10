import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PR_IMPACT_VARIANT_COUNT,
  PR_REVIEW_REPORTS_DIR,
  allPrImpactVariantPaths,
  prImpactVariantFiles,
  prImpactVariantPaths,
  prReviewOutputs,
  prReviewReportsDir,
} from "@src/pipelines/pr-review/output-contracts.js";

describe("prReviewOutputs", () => {
  it("builds the canonical artifact paths from one artifacts dir", () => {
    const base = "/tmp/task-123";

    expect(prReviewOutputs.context.resolve(base, undefined).path).toBe(path.join(base, "pr-context.json"));
    expect(prReviewOutputs.diff.resolve(base, undefined).path).toBe(path.join(base, "pr.diff"));
    expect(prReviewOutputs.updatedContext.resolve(base, undefined).path).toBe(path.join(base, "pr-context.updated.json"));
    expect(prReviewOutputs.updatedDiff.resolve(base, undefined).path).toBe(path.join(base, "pr.updated.diff"));
    expect(prReviewOutputs.reviewPlan.resolve(base, undefined).path).toBe(path.join(base, "review-plan.json"));
    expect(prReviewOutputs.summary.resolve(base, undefined).path).toBe(path.join(base, "summary.md"));
    expect(prReviewOutputs.finalComment.resolve(base, undefined).path).toBe(path.join(base, "final-comment.md"));
    expect(prReviewOutputs.review.resolve(base, undefined).path).toBe(path.join(base, "review.json"));
    expect(prReviewReportsDir(base)).toBe(path.join(base, PR_REVIEW_REPORTS_DIR));
  });

  it("builds report paths under the reports directory", () => {
    expect(prReviewOutputs.report.resolve("/tmp/task-123", { reportId: "group-01" }).path).toBe(
      path.join("/tmp/task-123", PR_REVIEW_REPORTS_DIR, "group-01.json"),
    );
  });

  it("builds root-level impact variant artifact paths", () => {
    expect(PR_IMPACT_VARIANT_COUNT).toBe(3);
    expect(prImpactVariantFiles(2)).toEqual({ diff: "pr.diff.v2", impact: "pr-impact.v2.md" });
    expect(prImpactVariantPaths("/tmp/task-123", 2)).toEqual({
      variant: 2,
      diff: path.join("/tmp/task-123", "pr.diff.v2"),
      impact: path.join("/tmp/task-123", "pr-impact.v2.md"),
    });
    expect(allPrImpactVariantPaths("/tmp/task-123").map((paths) => paths.variant)).toEqual([1, 2, 3]);
  });

});
